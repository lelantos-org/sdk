// Persistent storage for the proving artifacts.
//
// The default shape is 3x3, whose zkey is ~29 MB. Without persistence that
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

import { isHttpUrl } from "../core/url.js";
import { getLogger } from "../log/logger.js";

const log = getLogger("lelantos:prover:cache");

/**
 * Persistence port for artifact bytes, keyed by absolute URL.
 *
 * Implement this to store artifacts somewhere other than the Cache API —
 * IndexedDB, OPFS, an Electron userData directory — and install it with
 * `configureArtifactCache`.
 *
 * Unlike the wallet-tier ports (`NoteStore`, `TreePersistence`), **neither
 * method may throw**: those persist state whose loss is a correctness problem,
 * whereas a cache is an optimisation and a storage failure must degrade to a
 * network fetch. They are also `get`/`put` rather than `load`/`save` because
 * this port is keyed — it holds one entry per artifact URL, not one document.
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
export function cacheApiArtifactCache(): ArtifactCache | null {
    if (!available()) return null;
    return {
        async get(url) {
            // The Cache API stores `Request`s, which must be http(s). The
            // built-in caller already filters, so this guards direct users.
            if (!isHttpUrl(url)) return null;
            try {
                const cache = await caches.open(ARTIFACT_CACHE_NAME);
                const hit = await cache.match(url);
                if (!hit) return null;
                return new Uint8Array(await hit.arrayBuffer());
            } catch (err) {
                log.warn("artifact cache read failed; falling back to network", { url, err });
                return null;
            }
        },

        async put(url, bytes) {
            if (!isHttpUrl(url)) return;
            try {
                const cache = await caches.open(ARTIFACT_CACHE_NAME);
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
                // QuotaExceededError is the expected one at tens of MB per shape.
                log.warn("artifact cache write failed", { url, bytes: bytes.length, err });
            }
        },
    };
}

/**
 * Drop every cached artifact. Use after publishing new proving keys under
 * URLs that did not change, or to reclaim the ~90 MB all three shapes occupy.
 *
 * Resolves to `false` when there was nothing to delete or the Cache API is
 * unavailable.
 */
export async function clearArtifactCache(): Promise<boolean> {
    if (!available()) return false;
    try {
        return await caches.delete(ARTIFACT_CACHE_NAME);
    } catch (err) {
        log.warn("artifact cache clear failed", { err });
        return false;
    }
}
