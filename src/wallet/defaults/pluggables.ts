// Defaults for the simple pluggables: FMD client, note source, tree store,
// submitter.

import { assertNever, WalletConfigError } from "../../core/errors.js";
import { httpOptionsFor } from "../../core/http.js";
import type { Poseidon } from "../../crypto/index.js";
import { FmdClient } from "../../services/fmd-server/index.js";
import type { WalletConfig } from "../config.js";
import { FmdMatchesNoteSource, FmdNoteSource, type NoteSource } from "../note-source.js";
import { type NullifierPersistence, NullifierStore } from "../nullifier-store.js";
import { HttpRelayerSubmitter, type Submitter } from "../submitter.js";
import { type TreePersistence, TreeStore } from "../tree-store.js";

/**
 * Narrowed to what each function actually reads rather than the whole
 * `WalletConfig`, so the watch-only config — which has no `treeDepth` and no
 * `relayerAddress` — can reuse them.
 */
type FmdClientConfig = Pick<WalletConfig, "fmdUrl" | "chainId" | "fetchImpl">;
type NoteSourceConfig = Pick<WalletConfig, "syncStrategy">;

/**
 * Throws on a missing `fmdUrl` instead of casting it to `string`.
 *
 * `validateConfig` accepts a `noteSource` in place of an `fmdUrl`, so the field
 * can be absent. Reaching here without one means a default was needed that the
 * config cannot supply.
 */
export function defaultFmdClient(cfg: FmdClientConfig): FmdClient {
    if (!cfg.fmdUrl) {
        throw new WalletConfigError(
            "`fmdUrl` — needed to build the default note source, tree store or nullifier store; " +
                "supply it, or supply all three of `noteSource`, `treeStore` and `nullifierStore`",
        );
    }
    return new FmdClient(cfg.fmdUrl, cfg.chainId, httpOptionsFor(cfg.fetchImpl));
}

/**
 * `defaultFmdClient`, built at most once and only on demand.
 *
 * A config supplying every fmd-backed pluggable needs no client and may carry
 * no `fmdUrl`, so construction waits until a default calls for one.
 */
export function lazyFmdClient(cfg: FmdClientConfig): () => FmdClient {
    let fmd: FmdClient | undefined;
    return () => (fmd ??= defaultFmdClient(cfg));
}

export function defaultNoteSource(fmd: FmdClient, cfg: NoteSourceConfig): NoteSource {
    const strategy = cfg.syncStrategy;
    // An absent strategy and an explicit `full` both mean the firehose. Each
    // variant is named, so a third one fails to compile rather than defaulting.
    if (strategy === undefined || strategy.kind === "full") return new FmdNoteSource(fmd);
    if (strategy.kind === "matches") return new FmdMatchesNoteSource(fmd, strategy.token);
    return assertNever(strategy, "sync strategy");
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

/** Throws rather than casting `relayerUrl` to `string`; see `defaultFmdClient`. */
export function defaultSubmitter(cfg: WalletConfig): Submitter {
    if (!cfg.relayerUrl) {
        throw new WalletConfigError(
            "`relayerUrl` — needed to build the default submitter; supply it, or supply `submitter`",
        );
    }
    return new HttpRelayerSubmitter(cfg.relayerUrl, httpOptionsFor(cfg.fetchImpl));
}

/**
 * Build the WASM prover, falling back to snarkjs when the wasm module
 * cannot load (bundler did not resolve `#wasm/prover`, no wasm support).
 * Dynamic import keeps wasm-bindgen-rayon worker glue out of bundles that
 * opt out via `useWasmProver: false`.
 */
