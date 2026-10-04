// Loading and caching prover artifact bytes: fetch with retry and progress, an
// in-realm memo, the persistence port and the digest check for pinned artifacts.
//
// Paths come from `artifact-paths.ts`; this module knows nothing about shapes
// or the companion package. Backend-agnostic: does not import snarkjs.

import { linkAbort, memoAsyncByKey, retry } from "../core/async.js";
import { isHttpUrl, toAbsoluteUrl } from "../core/url.js";
import { isTransientStatus } from "../errors/network.js";
import { ProverArtifactsFailedError } from "../errors/prover.js";
import { getLogger } from "../log/logger.js";
import { IS_NODE, NODE_FS_PROMISES } from "../runtime/detect.js";
import { type ArtifactCache, cacheApiArtifactCache } from "./artifact-cache.js";
import { sha256Hex } from "./artifact-digests.js";

const log = getLogger("lelantos:prover:artifacts");

/**
 * Per-attempt download deadline. The zkey is tens of MB; 120 s covers the
 * default shape down to roughly 2 Mbps, and slower links fail rather than hang.
 * Override via `LoadArtifactOpts.timeoutMs`.
 */
const ARTIFACT_TIMEOUT_MS = 120_000;
const ARTIFACT_RETRIES = 2;

const _cache = memoAsyncByKey<string, Uint8Array>();

/**
 * `url\0digest` pairs already checked in this realm, so a backend that re-reads
 * the bytes on every proof (`SnarkjsProver`) hashes each artifact once.
 */
const _verified = new Set<string>();

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
 * skips the download. Pass `false` to opt out, or an {@link ArtifactCache} to
 * store the bytes elsewhere.
 *
 * The setting is per module realm, and a Web Worker is a separate realm. An
 * `ArtifactCache` cannot cross `postMessage`: call this inside the worker to
 * install one there, or pass `cacheArtifacts: false` to `WorkerProver` to opt
 * out.
 */
export function configureArtifactCache(cache: ArtifactCache | false): void {
    _persistent = cache === false ? null : cache;
}

function persistentCache(): ArtifactCache | null {
    // Not `??=`: `null` means explicitly disabled, and `??=` would re-probe it.
    if (_persistent === undefined) _persistent = cacheApiArtifactCache();
    return _persistent;
}

/**
 * Drop the memoised bytes for `paths`. The persistent cache is untouched, so a
 * later load is a cache hit rather than a download.
 *
 * For callers that copy the bytes elsewhere and will not request them again:
 * the wasm prover parses the zkey into linear memory, so keeping the
 * `Uint8Array` would hold the key twice for the realm's lifetime.
 * `SnarkjsProver` re-reads the bytes on every proof and does not release them.
 *
 * @internal
 */
export function releaseArtifactBytes(...paths: string[]): void {
    // `loadArtifactBytes` memoises on the absolute URL, so a page-relative
    // path would otherwise match no entry.
    for (const p of paths) {
        const key = toAbsoluteUrl(p);
        _cache.delete(key);
        // The next load is new bytes, from disk, cache or network: check them again.
        for (const seen of _verified) if (seen.startsWith(`${key}\0`)) _verified.delete(seen);
    }
}

/**
 * Drop the in-memory memo and the resolved persistence choice.
 *
 * @internal Test hook. Resetting the memo also simulates a fresh JS realm: a
 * worker shares the origin's Cache API but not this map.
 */
export function __resetArtifactCacheForTest(): void {
    _cache.clear();
    _verified.clear();
    _persistent = undefined;
}

/** Options for {@link loadArtifactBytes}. */
export interface LoadArtifactOpts {
    /**
     * Download progress. Loads are memoised by URL, so only the first caller
     * for a path receives it; concurrent callers await the same promise and
     * see none. A persistent-cache hit reports a single terminal event.
     */
    onProgress?: ((p: { loaded: number; total?: number; url: string }) => void) | undefined;
    signal?: AbortSignal | undefined;
    /** Per-attempt deadline. Default 120s. */
    timeoutMs?: number | undefined;
    /**
     * Expected SHA-256 of the bytes, lowercase hex. Bytes that hash to anything
     * else are never returned: the load rejects `PROVER_ARTIFACTS_FAILED`.
     */
    sha256?: string | undefined;
}

/**
 * Load artifact bytes from a filesystem path, `file://` href, or `http(s)://`
 * URL. Results are memoised for the life of the realm; a failed load is
 * evicted so callers can retry. http(s) loads also consult the persistent
 * cache (see {@link configureArtifactCache}).
 *
 * The path is absolutised first, so the memo key and the `isHttpUrl`
 * persistence check agree across spellings; a relative path would otherwise
 * lose persistence and download again in every realm.
 */
export async function loadArtifactBytes(
    path: string,
    opts: LoadArtifactOpts = {},
): Promise<Uint8Array> {
    const key = toAbsoluteUrl(path);
    const bytes = await _cache.get(key, () => load(key, opts));
    if (opts.sha256 === undefined) return bytes;

    // Checked on the way out of the memo rather than only inside `load`: the
    // entry may have been put there by a caller that named no digest.
    if (await matchesDigest(key, bytes, opts.sha256.toLowerCase())) return bytes;
    _cache.delete(key);
    throw digestMismatch(key);
}

/** Whether `bytes` hash to `expected`; a match is remembered for `key`. */
async function matchesDigest(key: string, bytes: Uint8Array, expected: string): Promise<boolean> {
    const seen = `${key}\0${expected}`;
    if (_verified.has(seen)) return true;
    if ((await sha256Hex(bytes)) !== expected) return false;
    _verified.add(seen);
    return true;
}

/** Not retryable: the source serves other bytes than the pinned release, and will again. */
function digestMismatch(path: string): ProverArtifactsFailedError {
    return new ProverArtifactsFailedError(
        path,
        "artifact does not match its pinned SHA-256; refusing to load it",
        { retryable: false },
    );
}

async function load(path: string, opts: LoadArtifactOpts): Promise<Uint8Array> {
    if (IS_NODE && !isHttpUrl(path)) {
        const { readFile } = await import(/* @vite-ignore */ NODE_FS_PROMISES);
        const target = path.startsWith("file://") ? new URL(path) : path;
        return new Uint8Array(await readFile(target));
    }

    // Only http(s) is persistable.
    const persistent = isHttpUrl(path) ? persistentCache() : null;
    const expected = opts.sha256?.toLowerCase();
    if (persistent) {
        const hit = await persistent.get(path);
        // A cached entry is no more trusted than the network: anything able to
        // write the origin's storage can replace it. A stale or tampered entry
        // is treated as a miss and overwritten by the download below.
        if (hit && expected !== undefined && !(await matchesDigest(path, hit, expected))) {
            log.warn("cached artifact does not match its pinned digest; refetching", { path });
        } else if (hit) {
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

    // Before the write, so bytes that fail their digest are never persisted.
    if (expected !== undefined && !(await matchesDigest(path, bytes, expected))) {
        throw digestMismatch(path);
    }

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

/** Non-retryable: the caller asked to stop. */
function abortedError(path: string, signal: AbortSignal, attempt: number): Error {
    return new ProverArtifactsFailedError(path, "download aborted by caller", {
        cause: signal.reason,
        retryable: false,
        details: { attempt },
    });
}

/**
 * Stream the body, reporting progress per chunk. `res.body` is absent under
 * some fetch polyfills and test mocks, hence the guard at the call site.
 *
 * Writes into one buffer sized from `content-length`, so a correct length
 * means no reallocation and a single copy of the body. The buffer doubles on
 * overflow, bounding the cost of a wrong or absent `content-length`.
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
