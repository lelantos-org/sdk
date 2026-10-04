// Origin storage durability. `navigator.storage.persist()` covers every store
// the origin owns (Cache API, IndexedDB, OPFS).

import { getLogger } from "../log/logger.js";

const log = getLogger("lelantos:storage");

/**
 * Ask the browser to exempt this origin's storage from eviction.
 *
 * Call once at startup on any site that proves in the browser: WebKit evicts
 * Cache API storage of an origin that goes unvisited, forcing the prover
 * artifacts to be downloaded again. It also protects persisted note and tree
 * stores.
 *
 * Resolves `false` when unsupported or denied. Chrome grants it on an
 * engagement heuristic rather than a prompt, so `false` is informational, not
 * an error to retry or report.
 */
export async function requestPersistentStorage(): Promise<boolean> {
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
