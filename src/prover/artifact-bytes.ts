// Loading and caching prover artifact bytes.
//
// Fetch with retry and progress, an in-realm memo, and the persistence port.
// Paths come from `artifact-paths.ts`; this module knows nothing about shapes
// or the companion package. Backend-agnostic: does not import snarkjs.

import { linkAbort, memoAsyncByKey, retry } from "../core/async.js";
import { isHttpUrl, toAbsoluteUrl } from "../core/url.js";
import { isTransientStatus } from "../errors/network.js";
import { ProverArtifactsFailedError } from "../errors/prover.js";
import { getLogger } from "../log/logger.js";
import { IS_NODE, NODE_FS_PROMISES } from "../runtime/detect.js";
import { type ArtifactCache, cacheApiArtifactCache } from "./artifact-cache.js";

const log = getLogger("lelantos:prover:artifacts");

/**
 * Per-attempt download deadline. The 4x6 zkey is tens of MB (2^17 FFT domain).
 *
 * 120 s covers the default shape down to roughly 3 Mbps; slower links fail
 * rather than hang. Override via `LoadArtifactOpts.timeoutMs`.
 */
const ARTIFACT_TIMEOUT_MS = 120_000;
const ARTIFACT_RETRIES = 2;

const _cache = memoAsyncByKey<string, Uint8Array>();

/**
 * `undefined` = not yet resolved, `null` = no persistence. Resolved lazily so
 * `configureArtifactCache` can run before the first load and the Cache API
 * probe does not run at module evaluation.
 */
let _persistent: ArtifactCache | null | undefined;

/**
 * Install (or disable) persistence for downloaded artifacts.
 *
 * Defaults to the Cache API where available, so a reload or the prover worker
 * (a separate JS realm with its own in-memory memo) skips the download. Pass
 * `false` to opt out, or an {@link ArtifactCache} to store the bytes elsewhere.
 *
 * State is module-local, and **a Web Worker is a separate module realm**. An
 * `ArtifactCache` is a live object and cannot cross `postMessage`; call this
 * inside the worker to override it there. To opt out in a worker, pass
 * `cacheArtifacts: false` to `WorkerProver`, which forwards it like `threads`.
 */
export function configureArtifactCache(cache: ArtifactCache | false): void {
    _persistent = cache === false ? null : cache;
}

function persistentCache(): ArtifactCache | null {
    // Not `??=`: `null` means "explicitly disabled" and must persist, but
    // `??=` would re-probe on `null`.
    if (_persistent === undefined) _persistent = cacheApiArtifactCache();
    return _persistent;
}

/**
 * Drop the memoised bytes for `path`, freeing them once nothing else holds a
 * reference. The persistent cache is untouched, so a later load is a cache
 * hit rather than a download.
 *
 * For callers that copy the bytes elsewhere and will not request them again:
 * the wasm prover parses the ~48 MB zkey into linear memory, so keeping the
 * `Uint8Array` would hold the key twice for the realm's lifetime.
 *
 * Not a general policy: `SnarkjsProver` re-reads the bytes on every proof.
 *
 * @internal
 */
export function releaseArtifactBytes(...paths: string[]): void {
    // Canonicalised because `loadArtifactBytes` memoises on the absolute URL;
    // a page-relative path (accepted by `WasmProver.build`) would otherwise
    // match no entry.
    for (const p of paths) _cache.delete(toAbsoluteUrl(p));
}

/**
 * Drop the in-memory memo and the resolved persistence choice.
 *
 * @internal Test hook. Resetting the memo also simulates a fresh JS realm: a
 * worker shares the origin's Cache API but not this map.
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
     * receives progress; concurrent callers await the same promise and see
     * none. A persistent-cache hit reports a single terminal event.
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
 * The path is absolutised first so the memo key and the `isHttpUrl`
 * persistence check agree across spellings. This happens here, not only in
 * `resolveArtifacts`, because a caller can pass a path straight to
 * `loadArtifactBytes`; a relative path would otherwise lose persistence and
 * re-download on every load.
 */
export function loadArtifactBytes(path: string, opts: LoadArtifactOpts = {}): Promise<Uint8Array> {
    const key = toAbsoluteUrl(path);
    return _cache.get(key, () => load(key, opts));
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
            // Terminal progress event so consumers complete on a hit.
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

    // Awaited so a worker terminated right after its first proof does not lose
    // the write. `put` swallows its own failures, so this cannot fail the load.
    if (persistent) await persistent.put(path, bytes);
    return bytes;
}

async function fetchArtifact(
    path: string,
    opts: LoadArtifactOpts,
    attempt: number,
): Promise<Uint8Array> {
    const timeoutMs = opts.timeoutMs ?? ARTIFACT_TIMEOUT_MS;

    // Checked per attempt before any request, so an abort is not followed by a
    // full download on the next retry. `linkAbort` already honours an aborted
    // parent; this check raises the error type callers match on.
    if (opts.signal?.aborted) throw abortedError(path, opts.signal, attempt);

    const cancel = linkAbort(opts.signal);
    const timer = setTimeout(() => cancel.abort(), timeoutMs);

    try {
        const res = await fetch(path, { signal: cancel.signal });
        if (!res.ok) {
            throw new ProverArtifactsFailedError(path, `HTTP ${res.status}`, {
                details: { status: res.status, attempt },
                retryable: isTransientStatus(res.status),
            });
        }
        return opts.onProgress && res.body
            ? await readWithProgress(res, path, opts.onProgress)
            : new Uint8Array(await res.arrayBuffer());
    } catch (err) {
        if (err instanceof ProverArtifactsFailedError) throw err;
        // Caller abort and timeout both surface as `AbortError`; the signal
        // distinguishes them so a cancellation is neither reported as a
        // timeout nor retried.
        if (opts.signal?.aborted) throw abortedError(path, opts.signal, attempt);
        const aborted = (err as { name?: string | undefined })?.name === "AbortError";
        throw new ProverArtifactsFailedError(
            path,
            aborted ? `download timed out after ${timeoutMs}ms` : "network error",
            { cause: err, retryable: true, details: { attempt } },
        );
    } finally {
        clearTimeout(timer);
        // Detach explicitly: a long-lived signal reused across calls would
        // accumulate one listener per call (Node warns past ten).
        cancel.dispose();
    }
}

/** Non-retryable: the caller asked to stop, so another attempt is not wanted. */
function abortedError(path: string, signal: AbortSignal, attempt: number): Error {
    return new ProverArtifactsFailedError(path, "download aborted by caller", {
        cause: signal.reason,
        retryable: false,
        details: { attempt },
    });
}

/**
 * Stream the body so a large zkey can report progress. `res.body` is absent
 * under some fetch polyfills and test mocks, hence the guard at the call site.
 *
 * Writes into one growable buffer sized from `content-length`, so a correct
 * length means zero reallocations and a single copy of the ~48 MB body
 * (collecting chunks and concatenating would hold two). Doubling on overflow
 * bounds the cost of a wrong or absent `content-length`.
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

    // `slice`, not `subarray`: a view would pin the oversized buffer for as
    // long as the artifact is held.
    return loaded === out.length ? out : out.slice(0, loaded);
}
