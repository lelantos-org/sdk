// Persistent storage for the proving artifacts.
//
// The default shape is 3x3, whose zkey is ~49 MB. Without persistence that
// download repeats on every page load *and* every worker spawn: the in-memory
// map in `./artifacts.ts` is per-JS-realm, and the prover worker has its own
// realm, so it never shares with the main thread.
//
// The Cache API fixes both at once — it is origin-scoped, so a worker read hits
// the entry the window wrote. It is also available in both Window and Worker
// contexts, which `localStorage` and (portably) OPFS are not.
//
// Nothing here may throw. A cache is an optimisation; a storage failure must
// degrade to a network fetch, never to a failed proof.

import { getLogger } from "../log/logger.js";

const log = getLogger("lelantos:prover:cache");

/**
 * Persistence port for artifact bytes, keyed by absolute URL.
 *
 * Implement this to store artifacts somewhere other than the Cache API —
 * IndexedDB, OPFS, an Electron userData directory — and install it with
 * `configureArtifactCache`.
 */
export interface ArtifactCache {
    /** Cached bytes for `url`, or `null` on a miss. Must not throw. */
    get(url: string): Promise<Uint8Array | null>;
    /** Store `bytes` under `url`. Must not throw. */
    put(url: string, bytes: Uint8Array): Promise<void>;
}

/**
 * Cache name. Versioned so a future format change can orphan old entries
 * rather than misread them; `clearArtifactCache` only clears the current one.
 */
export const ARTIFACT_CACHE_NAME = "lelantos-prover-v1";

/** The Cache API stores `Request`s, which must be http(s). */
function cacheable(url: string): boolean {
    return /^https?:\/\//.test(url);
}

function available(): boolean {
    return typeof caches !== "undefined" && typeof caches.open === "function";
}

/**
 * Cache API implementation of {@link ArtifactCache}, or `null` where the
 * Cache API is absent (Node, non-secure contexts, some embedded webviews).
 *
 * Entries are keyed by the exact artifact URL, so **the URL is the version**.
 * Proving keys are immutable per circuits release; serve a new release under a
 * new path (or call {@link clearArtifactCache}) rather than expecting
 * revalidation. There is deliberately no conditional request here — a
 * round-trip on every load would defeat the point.
 */
export function cacheApiArtifactCache(name: string = ARTIFACT_CACHE_NAME): ArtifactCache | null {
    if (!available()) return null;
    return {
        async get(url) {
            if (!cacheable(url)) return null;
            try {
                const cache = await caches.open(name);
                const hit = await cache.match(url);
                if (!hit) return null;
                return new Uint8Array(await hit.arrayBuffer());
            } catch (err) {
                log.warn("artifact cache read failed; falling back to network", { url, err });
                return null;
            }
        },

        async put(url, bytes) {
            if (!cacheable(url)) return;
            try {
                const cache = await caches.open(name);
                // `BodyInit` excludes SharedArrayBuffer-backed views. These
                // bytes always come from `fetch` or `readFile`, never from the
                // rayon shared heap, so the narrowing holds.
                const body = bytes as Uint8Array<ArrayBuffer>;
                await cache.put(
                    url,
                    new Response(body, {
                        headers: {
                            "content-type": "application/octet-stream",
                            "content-length": String(bytes.length),
                        },
                    }),
                );
            } catch (err) {
                // QuotaExceededError is the expected one at ~49 MB per shape.
                log.warn("artifact cache write failed", { url, bytes: bytes.length, err });
            }
        },
    };
}

/**
 * Drop every cached artifact. Use after publishing new proving keys under
 * URLs that did not change, or to reclaim the ~85 MB both shapes occupy.
 *
 * Resolves to `false` when there was nothing to delete or the Cache API is
 * unavailable.
 */
export async function clearArtifactCache(name: string = ARTIFACT_CACHE_NAME): Promise<boolean> {
    if (!available()) return false;
    try {
        return await caches.delete(name);
    } catch (err) {
        log.warn("artifact cache clear failed", { err });
        return false;
    }
}

/**
 * Ask the browser to exempt this origin's storage from eviction.
 *
 * Worth calling once at startup on any site that proves in the browser: WebKit
 * evicts Cache API storage after ~7 days without a visit, which silently
 * restores the ~49 MB cold start. Resolves `false` when unsupported or denied
 * — Chrome grants it on an engagement heuristic rather than a prompt, so a
 * `false` here is informational, not an error.
 */
export async function persistArtifactStorage(): Promise<boolean> {
    try {
        const storage = (globalThis as { navigator?: { storage?: StorageManager } }).navigator
            ?.storage;
        if (typeof storage?.persist !== "function") return false;
        return await storage.persist();
    } catch (err) {
        log.warn("storage persistence request failed", { err });
        return false;
    }
}
