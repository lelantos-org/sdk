// Wallet runtime configuration. Every external dependency is pluggable.

import type { ChainAdapter } from "../chain/port.js";
import type { Prover, ProverPaths } from "../prover/types.js";
import type { Scanner } from "../sync/scanner.js";
import type { NoteSource } from "./note-source.js";
import type { NoteStore } from "./note-store.js";
import type { CoinSelector } from "./selection.js";
import type { Submitter } from "./submitter.js";
import type { TreePersistence, TreeStore } from "./tree-store.js";

/**
 * Default `NoteSource` strategy. `full` → `/v1/notes` firehose;
 * `matches` → server-side FMD-filtered `/v1/matches`. Ignored when
 * `noteSource` is set.
 */
export type SyncStrategy = { kind: "full" } | { kind: "matches"; subscriptionId: number };

export interface WalletConfig {
    /** Bound into SNARK + FMD query. */
    chainId: bigint;
    /** Matches deployed contract + circuit build. */
    treeDepth: number;
    /** SNARK-bound; must equal relayer pipeline signer or contract reverts. */
    relayerAddress: string;
    chain: ChainAdapter;
    /** Overrides `chain.fetchFeeBps()`. 1 bp = 0.01%. */
    feeBps?: bigint;

    /** Required if `noteSource` is not provided. */
    fmdUrl?: string;
    /** Required if `submitter` is not provided. */
    relayerUrl?: string;
    /** Required if `prover` is not provided. */
    proverPaths?: ProverPaths;

    /** Defaults to in-memory. */
    noteStore?: NoteStore;
    /** Defaults to fmd-webserver. */
    noteSource?: NoteSource;
    /** Defaults to a TreeStore backed by fmd-webserver commitment chunks. */
    treeStore?: TreeStore;
    /**
     * Plug in a persistence backend (e.g. IndexedDB) to resume sync across
     * page loads. Ignored when `treeStore` is provided directly.
     */
    treePersistence?: TreePersistence;
    /** Default `{ kind: "full" }`. */
    syncStrategy?: SyncStrategy;
    /** Defaults to HTTP relayer. */
    submitter?: Submitter;
    /** Defaults to the WASM prover (snarkjs fallback on wasm load failure). */
    prover?: Prover;
    /** Defaults to SFRT. */
    selector?: CoinSelector;
    /**
     * Defaults to `LocalScanner`. Use `WorkerPoolScanner` for parallel
     * off-main-thread scan.
     */
    scanner?: Scanner;
}

/**
 * `WalletConfig` after `connect()` has filled in every default.
 *
 * The distinction is load-bearing. `WalletConfig` is all-optional because a
 * caller may omit anything; `Wallet` then had eight getters of the form
 * `return this.cfg.x as T`, each asserting a default it could not see. With
 * the resolved type those casts are gone and the compiler checks the wiring.
 */
export interface ResolvedWalletConfig extends WalletConfig {
    noteStore: NoteStore;
    noteSource: NoteSource;
    treeStore: TreeStore;
    submitter: Submitter;
    prover: Prover;
    selector: CoinSelector;
    scanner: Scanner;
}
