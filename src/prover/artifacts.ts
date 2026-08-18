// Locating and loading prover artifacts.
//
// Descriptor coercion, bundled/companion-package lookup, and the byte cache.
// Backend-agnostic: nothing here touches snarkjs.

import { linkAbort, retry } from "../core/async.js";
import { ProverArtifactsFailedError, ProverArtifactsMissingError } from "../core/errors.js";
import { type CircuitShape, DEFAULT_SHAPE, shapeId } from "../core/shape.js";
import { isHttpUrl, toAbsoluteUrl, urlToString } from "../core/url.js";
import { getLogger } from "../log/logger.js";
import { type ArtifactCache, cacheApiArtifactCache } from "./artifact-cache.js";
import type { ProverArtifacts, ProverPaths } from "./types.js";

export type { ProverArtifacts } from "./types.js";

/**
 * Companion package — published to GitHub Packages (not public npm),
 * so jsDelivr cannot proxy it and there is no built-in browser CDN default.
 * Integrators add it explicitly to avoid pulling ~85 MB of proving keys into
 * every install.
 */
const COMPANION_PKG = "@lelantos-org/circuits";

const log = getLogger("lelantos:prover:artifacts");

/**
 * The zkey is ~36 MB at 2x2 and ~49 MB at 3x3, which is `DEFAULT_SHAPE`. A
 * stalled download needs a long leash but not none.
 *
 * 120 s covers the default shape down to roughly 3 Mbps. Slower links fail
 * here rather than hanging; raise it via `LoadArtifactOpts.timeoutMs` to
 * support slower clients.
 */
const ARTIFACT_TIMEOUT_MS = 120_000;
const ARTIFACT_RETRIES = 2;

/**
 * Coerce `ProverPaths` or `ProverArtifacts` to snarkjs-friendly path strings.
 *
 * @internal
 */
export function resolveArtifacts(input: ProverPaths | ProverArtifacts): {
    wasmPath: string;
    zkeyPath: string;
} {
    // Canonicalised here as well as in `loadArtifactBytes` — not redundantly.
    // This output is what `WorkerProver` posts across to its worker, and inside
    // a worker `location.href` is the *worker script* URL, so a relative path
    // resolved on the far side would resolve against a different base.
    if ("wasmPath" in input) {
        return {
            wasmPath: toAbsoluteUrl(input.wasmPath),
            zkeyPath: toAbsoluteUrl(input.zkeyPath),
        };
    }
    return {
        wasmPath: toAbsoluteUrl(urlToString(input.circuit)),
        zkeyPath: toAbsoluteUrl(urlToString(input.zkey)),
    };
}

let _DEFAULT_PATHS: ProverPaths | null = null;

/** @internal */
export function configureProver(paths: ProverPaths | ProverArtifacts): void {
    _DEFAULT_PATHS = resolveArtifacts(paths);
}

/**
 * Resolve default Groth16 prover artifacts for `shape`.
 *
 * Artifacts are named after the shape — `2x2.wasm` / `2x2_final.zkey`,
 * `3x3.wasm` / `3x3_final.zkey` — which is the convention the circuits
 * package builds under. Resolution order:
 *   1. `LELANTOS_PROVER_ARTIFACTS_DIR` env var (Node) — must contain the
 *      pair for the shape in use.
 *   2. Companion `@lelantos-org/circuits` npm package (Node) — via
 *      `import.meta.resolve`.
 *   3. Explicit `opts.cdn` URL (browser). No built-in browser default
 *      because the companion lives on GitHub Packages.
 *
 * Throws `ProverArtifactsMissingError` listing every path tried. A shape the
 * companion has no proving key for fails here rather than at proof time.
 *
 * @internal
 */
export async function bundledProverArtifacts(
    opts: {
        runtime?: "node" | "browser" | undefined;
        cdn?: string | undefined;
        shape?: CircuitShape | undefined;
    } = {},
): Promise<ProverArtifacts> {
    const runtime = opts.runtime ?? detectRuntime();
    const id = shapeId(opts.shape ?? DEFAULT_SHAPE);
    const tried: string[] = [];

    let companionCause: unknown;

    if (runtime === "node") {
        const envDir =
            typeof process !== "undefined" ? process.env.LELANTOS_PROVER_ARTIFACTS_DIR : undefined;
        if (envDir) {
            const base = envDir.replace(/\/$/, "");
            const pair = { circuit: `${base}/${id}.wasm`, zkey: `${base}/${id}_final.zkey` };
            // Probed, not trusted. Returning unconditionally made `tried.push`
            // above dead — it could never reach an error — and deferred a
            // typo'd directory to an `ENOENT` at proof time instead of the
            // `ProverArtifactsMissingError` this function promises.
            if (await bothExist(pair)) return pair;
            tried.push(`env LELANTOS_PROVER_ARTIFACTS_DIR=${envDir} (files not found)`);
        }
        const companion = await tryResolveCompanion(id);
        if (companion.found) return companion.artifacts;
        companionCause = companion.cause;
        tried.push(`npm package ${COMPANION_PKG} (subpath ./${id}/${id}_final.zkey)`);
    }

    // Not `else if`: a CDN is a valid source on Node too. `loadArtifactBytes`
    // handles `http(s)` there perfectly — it only treats a *non*-URL as a
    // filesystem path — so refusing to consider `opts.cdn` outside a browser
    // failed a Node service that had configured exactly the thing it needed,
    // with an error that did not even mention the option it ignored.
    if (opts.cdn) {
        const base = opts.cdn.replace(/\/$/, "");
        return { circuit: `${base}/${id}.wasm`, zkey: `${base}/${id}_final.zkey` };
    }
    tried.push(
        runtime === "browser"
            ? "opts.cdn (browser requires explicit `proverArtifactsCdn`)"
            : "opts.cdn (not set)",
    );

    // The companion's own failure is attached rather than dropped: a package
    // that is installed but broken — missing export subpath, wrong version —
    // is otherwise indistinguishable from one that is absent.
    throw new ProverArtifactsMissingError(tried, id, { cause: companionCause });
}

function detectRuntime(): "node" | "browser" {
    const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    return isBrowser ? "browser" : "node";
}

/**
 * Outcome of probing the companion package. A discriminated union rather than
 * two optional fields, so a caller cannot read `artifacts` without having
 * established that the probe succeeded.
 */
type CompanionProbe =
    | { readonly found: true; readonly artifacts: ProverArtifacts }
    | { readonly found: false; readonly cause?: unknown };

/** Resolve the companion package's artifacts. Never throws. */
async function tryResolveCompanion(id: string): Promise<CompanionProbe> {
    // `import.meta.resolve` sync in Node ≥ 20.6; try/catch so a missing
    // companion reports cleanly.
    try {
        const wasm = (import.meta as { resolve?: (s: string) => string }).resolve?.(
            `${COMPANION_PKG}/${id}/${id}.wasm`,
        );
        const zkey = (import.meta as { resolve?: (s: string) => string }).resolve?.(
            `${COMPANION_PKG}/${id}/${id}_final.zkey`,
        );
        if (!wasm || !zkey) return { found: false };
        return { found: true, artifacts: { circuit: new URL(wasm), zkey: new URL(zkey) } };
    } catch (cause) {
        // Returned rather than swallowed, so the thrown
        // `ProverArtifactsMissingError` can say *why* the companion did not
        // resolve — an installed-but-broken package looks identical to an
        // absent one otherwise.
        log.debug("companion artifact package did not resolve", { id, cause });
        return { found: false, cause };
    }
}

/** Both artifact paths present on disk. Node only; anything else is a URL. */
async function bothExist(pair: { circuit: string; zkey: string }): Promise<boolean> {
    if (!IS_NODE) return true;
    try {
        const { access } = await import(/* @vite-ignore */ NODE_FS_PROMISES);
        await Promise.all([access(pair.circuit), access(pair.zkey)]);
        return true;
    } catch {
        return false;
    }
}

// --- byte loading ---------------------------------------------------------

const IS_NODE = typeof process !== "undefined" && !!process.versions?.node;
const NODE_FS_PROMISES = "node:fs/promises";

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
 * wasm prover parses the ~49 MB zkey into linear memory and never reads the
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

    // Checked before anything is opened, and this runs once per retry — so a
    // user who cancelled during the first attempt used to have the remaining
    // attempts each download the full ~49 MB to completion. Cancelling made
    // the SDK transfer more bytes, not fewer. (`linkAbort` honours an
    // already-aborted parent, but the error type matters here.)
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
 * does zero reallocations and holds exactly one copy of the ~49 MB body.
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
