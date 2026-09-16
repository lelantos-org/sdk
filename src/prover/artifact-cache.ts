// Persistent storage for the proving artifacts.
//
// The default shape's zkey is ~48 MB. The in-memory memo in
// `./artifact-bytes.ts` is per JS realm and the prover worker has its own realm, so
// without persistence the download repeats on every page load and worker spawn.
//
// The Cache API is origin-scoped (a worker read hits the entry the window
// wrote) and available in both Window and Worker contexts, unlike
// `localStorage` and (portably) OPFS.
//
// Nothing here may throw: a storage failure must degrade to a network fetch,
// never to a failed proof.

import { isHttpUrl } from "../core/url.js";
import { getLogger } from "../log/logger.js";

const log = getLogger("lelantos:prover:cache");

/**
 * Persistence port for artifact bytes, keyed by absolute URL.
 *
 * Implement this to store artifacts outside the Cache API (IndexedDB, OPFS, an
 * Electron userData directory) and install it with `configureArtifactCache`.
 *
 * Unlike the wallet-tier ports (`NoteStore`, `TreePersistence`), whose data
 * loss is a correctness problem, **neither method may throw**: a storage
 * failure must degrade to a network fetch. The port is keyed (one entry per
 * artifact URL), hence `get`/`put` rather than `load`/`save`.
 */
export interface ArtifactCache {
    /** Cached bytes for `url`, or `null` on a miss. Must not throw. */
    get(url: string): Promise<Uint8Array | null>;
    /** Store `bytes` under `url`. Must not throw. */
    put(url: string, bytes: Uint8Array): Promise<void>;
}

/**
 * Cache name. Versioned so a format change orphans existing entries rather than
 * misreading them; `clearArtifactCache` clears only the current version.
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
 * new path (or call {@link clearArtifactCache}). Entries are never revalidated,
 * to avoid a round-trip on every load.
 */
export function cacheApiArtifactCache(): ArtifactCache | null {
    if (!available()) return null;
    return {
        async get(url) {
            // The Cache API stores `Request`s, which must be http(s). Guards
            // direct callers; the built-in caller already filters.
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
                // bytes come from `fetch` or `readFile`, never the rayon shared
                // heap, so the narrowing is sound.
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
                // Typically QuotaExceededError, at tens of MB per shape.
                log.warn("artifact cache write failed", { url, bytes: bytes.length, err });
            }
        },
    };
}

/**
 * Drop every cached artifact. Use after publishing new proving keys under
 * unchanged URLs, or to reclaim the ~52 MB the artifacts occupy.
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
