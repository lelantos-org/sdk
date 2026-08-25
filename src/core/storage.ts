// Origin storage durability.
//
// Not artifact- or prover-specific despite being introduced for the prover's
// ~29 MB zkey: `navigator.storage.persist()` covers every store the origin
// owns — Cache API, IndexedDB, OPFS — so a wallet-tier `NoteStore` or
// `TreePersistence` backed by IndexedDB wants the same call.

import { getLogger } from "../log/logger.js";

const log = getLogger("lelantos:storage");

/**
 * Ask the browser to exempt this origin's storage from eviction.
 *
 * Worth calling once at startup on any site that proves in the browser: WebKit
 * evicts Cache API storage after ~7 days without a visit, which silently
 * restores the full artifact download. It equally protects a persisted note or
 * tree store.
 *
 * Resolves `false` when unsupported or denied. Chrome grants it on an
 * engagement heuristic rather than a prompt, so `false` is informational
 * rather than an error — there is nothing to retry or report.
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
