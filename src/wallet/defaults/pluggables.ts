// Defaults for the simple pluggables: FMD client, note source, tree store,
// submitter.

import type { Poseidon } from "../../crypto/index.js";
import type { Jubjub } from "../../crypto/jubjub.js";
import { FmdClient } from "../../services/fmd-server/client.js";
import type { WalletConfig } from "../config.js";
import { FmdMatchesNoteSource, FmdNoteSource, type NoteSource } from "../note-source.js";
import { HttpRelayerSubmitter, type Submitter } from "../submitter.js";
import { type TreePersistence, TreeStore } from "../tree-store.js";

export function defaultFmdClient(cfg: WalletConfig): FmdClient {
    return new FmdClient(cfg.fmdUrl as string, cfg.chainId);
}

export function defaultNoteSource(fmd: FmdClient, cfg: WalletConfig, J: Jubjub): NoteSource {
    if (cfg.syncStrategy?.kind === "matches") {
        return new FmdMatchesNoteSource(fmd, J, cfg.syncStrategy.subscriptionId);
    }
    return new FmdNoteSource(fmd, J);
}

export function defaultTreeStore(
    fmd: FmdClient,
    P: Poseidon,
    persistence?: TreePersistence,
): Promise<TreeStore> | TreeStore {
    return persistence ? TreeStore.withPersistence(P, fmd, persistence) : new TreeStore(P, fmd);
}

export function defaultSubmitter(cfg: WalletConfig): Submitter {
    return new HttpRelayerSubmitter(cfg.relayerUrl as string);
}

/**
 * Build the WASM prover, falling back to snarkjs when the wasm module
 * cannot load (bundler did not resolve `#wasm/prover`, no wasm support).
 * Dynamic import keeps wasm-bindgen-rayon worker glue out of bundles that
 * opt out via `useWasmProver: false`.
 */
