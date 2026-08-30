// Loading prover artifact bytes, and keeping them.
//
// Fetch with retry and progress, an in-realm memo, and the persistence port.
// Given a path by `artifact-paths.ts`; knows nothing about shapes or the
// companion package.
//
// Backend-agnostic: nothing here touches snarkjs.

import { linkAbort, retry } from "../core/async.js";
import { ProverArtifactsFailedError } from "../core/errors.js";
import { IS_NODE, NODE_FS_PROMISES } from "../core/runtime.js";
import { isHttpUrl, toAbsoluteUrl } from "../core/url.js";
import { getLogger } from "../log/logger.js";
import { type ArtifactCache, cacheApiArtifactCache } from "./artifact-cache.js";

const log = getLogger("lelantos:prover:artifacts");

/**
 * The 4x6 zkey is tens of MB — it sits in the 2^17 FFT domain. A stalled
 * download needs a long leash but not none.
 *
 * 120 s covers the default shape down to roughly 3 Mbps. Slower links fail
 * here rather than hanging; raise it via `LoadArtifactOpts.timeoutMs` to
 * support slower clients.
 */
const ARTIFACT_TIMEOUT_MS = 120_000;
const ARTIFACT_RETRIES = 2;

const _cache = new Map<string, Promise<Uint8Array>>();

/**
 * `undefined` = not yet resolved, `null` = no persistence. Resolved lazily so
 * an integrator can call `configureArtifactCache` before the first load, and
 * so the Cache API probe happens off module-eval.
 */
let _persistent: ArtifactCache | null | undefined;

/**
 * Install (or disable) persistence for downloaded artifacts.
 *
 * Defaults to the Cache API wherever it exists, which is what makes a reload
 * — and the prover worker, which has its own JS realm and its own copy of the
 * in-memory map below — skip the download. Pass `false` to opt out, or an
 * {@link ArtifactCache} to store the bytes somewhere else.
 *
 * State is module-local, and **a Web Worker is a separate module realm**. An
 * `ArtifactCache` is a live object, so it cannot cross a `postMessage`
 * boundary; call this inside the worker to override it there. The plain
 * opt-out does cross — pass `cacheArtifacts: false` to `WorkerProver`, which
 * forwards it the way it forwards `threads`.
 */
export function configureArtifactCache(cache: ArtifactCache | false): void {
    _persistent = cache === false ? null : cache;
}

function persistentCache(): ArtifactCache | null {
    // Not `??=`: `null` means "explicitly disabled" and must stick, but
    // `null ?? probe()` would re-enable it on the very next load.
    if (_persistent === undefined) _persistent = cacheApiArtifactCache();
    return _persistent;
}

/**
 * Drop the memoised bytes for `path`, freeing them once nothing else holds a
 * reference. The persistent cache is untouched, so a later load is a cache
 * hit rather than a download.
 *
 * For callers that copy the bytes somewhere else and will not ask again — the
 * wasm prover parses the ~29 MB zkey into linear memory and never reads the
 * `Uint8Array` afterwards, so without this every prover realm holds the key
 * twice for its whole life.
 *
 * Not safe as a blanket policy: `SnarkjsProver` re-reads the bytes on every
 * proof. Only the owner of a build knows it is done with them.
 *
 * @internal
 */
export function releaseArtifactBytes(...paths: string[]): void {
    // Canonicalised, because `loadArtifactBytes` memoises on the absolute URL.
    // Deleting the raw string matched nothing for any page-relative path — the
    // exact spelling `WasmProver.build` accepts from callers — so the entry
    // this function exists to drop stayed pinned for the realm's lifetime.
    for (const p of paths) _cache.delete(toAbsoluteUrl(p));
}

/**
 * Drop the in-memory memo and the resolved persistence choice.
 *
 * @internal Test hook. Resetting the memo is also how a test simulates a
 * fresh JS realm — a worker shares the origin's Cache API but not this map.
 */
export function __resetArtifactCacheForTest(): void {
    _cache.clear();
    _persistent = undefined;
}

/** Options for {@link loadArtifactBytes}. */
export interface LoadArtifactOpts {
    /**
     * Download progress for the zkey.
     *
     * Results are cached by URL, so only the first caller for a given path
     * receives progress; a concurrent second caller awaits the same promise
     * and sees none. A persistent-cache hit reports a single terminal event
     * rather than nothing, so a progress bar completes instead of hanging.
     */
    onProgress?: ((p: { loaded: number; total?: number; url: string }) => void) | undefined;
    signal?: AbortSignal | undefined;
    /** Per-attempt deadline. Default 120s. */
    timeoutMs?: number | undefined;
}

/**
 * Load artifact bytes from a filesystem path, `file://` href, or `http(s)://`
 * URL. Results are memoised for the life of the realm; a failed load is
 * evicted so callers can retry.
 *
 * http(s) loads also consult the persistent cache — see
 * {@link configureArtifactCache}.
 *
 * The path is absolutised first, because that is what makes the memo key and
 * the `isHttpUrl` persistence check agree across spellings. Doing it here
 * rather than only in `resolveArtifacts` is deliberate: a caller-supplied
 * `proverPaths` reaches this function without passing through there — via
 * `WalletConfig.proverPaths`, the presets helper, `BundleCommon`, or the public
 * `WasmProver.build` entrypoint — and a relative base on any of those routes
 * would otherwise silently lose persistence and re-download on every load.
 */
export function loadArtifactBytes(path: string, opts: LoadArtifactOpts = {}): Promise<Uint8Array> {
    const key = toAbsoluteUrl(path);
    const cached = _cache.get(key);
    if (cached) return cached;
    const p = load(key, opts).catch((err) => {
        _cache.delete(key);
        throw err;
    });
    _cache.set(key, p);
    return p;
}

async function load(path: string, opts: LoadArtifactOpts): Promise<Uint8Array> {
    if (IS_NODE && !isHttpUrl(path)) {
        const { readFile } = await import(/* @vite-ignore */ NODE_FS_PROMISES);
        const target = path.startsWith("file://") ? new URL(path) : path;
        return new Uint8Array(await readFile(target));
    }

    // Only http(s) is persistable; a local path is already cheap to re-read.
    const persistent = isHttpUrl(path) ? persistentCache() : null;
    if (persistent) {
        const hit = await persistent.get(path);
        if (hit) {
            log.info("artifact cache hit", { path, bytes: hit.length });
            // A progress consumer would otherwise sit at 0% forever on a hit.
            opts.onProgress?.({ loaded: hit.length, total: hit.length, url: path });
            return hit;
        }
    }

    const bytes = await retry((attempt) => fetchArtifact(path, opts, attempt), {
        retries: ARTIFACT_RETRIES,
        backoffMs: 500,
        shouldRetry: (err) => err instanceof ProverArtifactsFailedError && err.retryable,
        onRetry: ({ attempt, delayMs, err }) =>
            log.warn("retrying artifact download", { path, attempt: attempt + 1, delayMs, err }),
    });

    // Awaited, not fire-and-forget: a worker terminated right after its first
    // proof would otherwise lose the write and re-download next time. `put`
    // swallows its own failures, so this cannot fail the load.
    if (persistent) await persistent.put(path, bytes);
    return bytes;
}

async function fetchArtifact(
    path: string,
    opts: LoadArtifactOpts,
    attempt: number,
): Promise<Uint8Array> {
    const timeoutMs = opts.timeoutMs ?? ARTIFACT_TIMEOUT_MS;

    // Checked once per retry, before anything is opened, so an abort during
    // one attempt is not followed by a full ~29 MB download on the next.
    // `linkAbort` honours an already-aborted parent; this raises the specific
    // error type callers match on.
    if (opts.signal?.aborted) throw abortedError(path, opts.signal, attempt);

    const cancel = linkAbort(opts.signal);
    const timer = setTimeout(() => cancel.abort(), timeoutMs);

    try {
        const res = await fetch(path, { signal: cancel.signal });
        if (!res.ok) {
            throw new ProverArtifactsFailedError(path, `HTTP ${res.status}`, {
                context: { status: res.status, attempt },
                // 4xx will not fix itself; 5xx and 408/429 might.
                retryable: res.status >= 500 || res.status === 408 || res.status === 429,
            });
        }
        return opts.onProgress && res.body
            ? await readWithProgress(res, path, opts.onProgress)
            : new Uint8Array(await res.arrayBuffer());
    } catch (err) {
        if (err instanceof ProverArtifactsFailedError) throw err;
        // The caller's abort and the timeout both surface as `AbortError`, so
        // ask the signal which one it was. Reporting a cancellation as
        // "download timed out" is wrong, and retrying it is worse.
        if (opts.signal?.aborted) throw abortedError(path, opts.signal, attempt);
        const aborted = (err as { name?: string | undefined })?.name === "AbortError";
        throw new ProverArtifactsFailedError(
            path,
            aborted ? `download timed out after ${timeoutMs}ms` : "network error",
            { cause: err, retryable: true, context: { attempt } },
        );
    } finally {
        clearTimeout(timer);
        // Detached explicitly: a long-lived signal reused across many
        // `loadArtifactBytes` calls would otherwise accumulate one listener
        // per call, which Node warns about past ten.
        cancel.dispose();
    }
}

/** Non-retryable: the caller asked to stop, so another attempt is not wanted. */
function abortedError(path: string, signal: AbortSignal, attempt: number): Error {
    return new ProverArtifactsFailedError(path, "download aborted by caller", {
        cause: signal.reason,
        retryable: false,
        context: { attempt },
    });
}

/**
 * Stream the body so a large zkey can report progress. `res.body` is
 * absent under some fetch polyfills and test mocks, hence the guard at the
 * call site.
 *
 * One growable buffer, written in place. `content-length` sizes it up front, so
 * the overwhelmingly common case — a CDN that declares the length correctly —
 * does zero reallocations and holds exactly one copy of the ~29 MB body.
 * Collecting chunks and concatenating at the end would hold two, right before
 * the prover allocates a third in wasm memory.
 *
 * Doubling on overflow keeps a wrong or absent `content-length` merely slower
 * rather than pathological: the earlier chunk-list-plus-merge fallback peaked
 * at three copies when a server under-declared.
 */
async function readWithProgress(
    res: Response,
    url: string,
    onProgress: NonNullable<LoadArtifactOpts["onProgress"]>,
): Promise<Uint8Array> {
    const total = Number(res.headers.get("content-length")) || undefined;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    let out = new Uint8Array(total ?? 0);
    let loaded = 0;

    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (loaded + value.length > out.length) {
            const grown = new Uint8Array(Math.max(loaded + value.length, out.length * 2));
            grown.set(out.subarray(0, loaded));
            out = grown;
        }
        out.set(value, loaded);
        loaded += value.length;
        onProgress({ loaded, url, ...(total !== undefined ? { total } : {}) });
    }

    // `slice`, not `subarray`: a view would pin the whole oversized buffer for
    // as long as the artifact is held.
    return loaded === out.length ? out : out.slice(0, loaded);
}
