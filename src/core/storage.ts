// Origin storage durability.
//
// Not artifact- or prover-specific: `navigator.storage.persist()` covers every
// store the origin owns (Cache API, IndexedDB, OPFS), so an IndexedDB-backed
// `NoteStore` or `TreePersistence` benefits from the same call.

import { getLogger } from "../log/logger.js";

const log = getLogger("lelantos:storage");

/**
 * Ask the browser to exempt this origin's storage from eviction.
 *
 * Call once at startup on any site that proves in the browser: WebKit evicts
 * Cache API storage after ~7 days without a visit, forcing the ~48 MB artifact
 * download again. It also protects persisted note and tree stores.
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
