// Defaults for the simple pluggables: FMD client, note source, tree store,
// submitter.

import { httpOptionsFor } from "../../core/http.js";
import type { Poseidon } from "../../crypto/index.js";
import type { Jubjub } from "../../crypto/jubjub.js";
import { FmdClient } from "../../services/fmd-server/client.js";
import type { WalletConfig } from "../config.js";
import { FmdMatchesNoteSource, FmdNoteSource, type NoteSource } from "../note-source.js";
import { type NullifierPersistence, NullifierStore } from "../nullifier-store.js";
import { HttpRelayerSubmitter, type Submitter } from "../submitter.js";
import { type TreePersistence, TreeStore } from "../tree-store.js";

export function defaultFmdClient(cfg: WalletConfig): FmdClient {
    return new FmdClient(cfg.fmdUrl as string, cfg.chainId, httpOptionsFor(cfg.fetchImpl));
}

export function defaultNoteSource(fmd: FmdClient, cfg: WalletConfig, J: Jubjub): NoteSource {
    if (cfg.syncStrategy?.kind === "matches") {
        return new FmdMatchesNoteSource(fmd, J, cfg.syncStrategy.token);
    }
    return new FmdNoteSource(fmd, J);
}

export function defaultTreeStore(
    fmd: FmdClient,
    P: Poseidon,
    persistence?: TreePersistence,
    treeDepth?: number,
): Promise<TreeStore> | TreeStore {
    return persistence
        ? TreeStore.withPersistence(P, fmd, persistence, treeDepth)
        : new TreeStore(P, fmd, treeDepth);
}

export function defaultNullifierStore(
    fmd: FmdClient,
    persistence?: NullifierPersistence,
): Promise<NullifierStore> | NullifierStore {
    return persistence ? NullifierStore.withPersistence(fmd, persistence) : new NullifierStore(fmd);
}

export function defaultSubmitter(cfg: WalletConfig): Submitter {
    return new HttpRelayerSubmitter(cfg.relayerUrl as string, httpOptionsFor(cfg.fetchImpl));
}

/**
 * Build the WASM prover, falling back to snarkjs when the wasm module
 * cannot load (bundler did not resolve `#wasm/prover`, no wasm support).
 * Dynamic import keeps wasm-bindgen-rayon worker glue out of bundles that
 * opt out via `useWasmProver: false`.
 */
