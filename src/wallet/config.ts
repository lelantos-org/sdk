// Wallet runtime configuration. Every external dependency is pluggable.

import type { ChainAdapter } from "../chain/port.js";
import type { CircuitShape } from "../core/shape.js";
import type { Prover, ProverPaths } from "../prover/types.js";
import type { Scanner } from "../sync/scanner.js";
import type { NoteSource } from "./note-source.js";
import type { NoteStore } from "./note-store.js";
import type { NullifierPersistence, NullifierStore } from "./nullifier-store.js";
import type { CoinSelector } from "./selection.js";
import type { Submitter } from "./submitter.js";
import type { TreePersistence, TreeStore } from "./tree-store.js";

/**
 * Default `NoteSource` strategy. `full` → `/v1/notes` firehose;
 * `matches` → server-side FMD-filtered `/v1/matches`, addressed by the
 * capability token `FmdClient.createSubscription` returns once. Ignored when
 * `noteSource` is set.
 */
export type SyncStrategy = { kind: "full" } | { kind: "matches"; token: string };

export interface WalletConfig {
    /** Bound into SNARK + FMD query. */
    chainId: bigint;
    /** Matches deployed contract + circuit build. */
    treeDepth: number;
    /**
     * Input/output arity of the transact circuit. Defaults to
     * `DEFAULT_SHAPE` (3×3). A 2×2 pool must pass `TRANSACT_2X2` explicitly —
     * see `core/shape.ts`.
     */
    shape?: CircuitShape | undefined;
    /** SNARK-bound; must equal relayer pipeline signer or contract reverts. */
    relayerAddress: string;
    chain: ChainAdapter;
    /** Overrides `chain.fetchFeeBps()`. 1 bp = 0.01%. */
    feeBps?: bigint | undefined;

    /**
     * `fetch` used by every default HTTP pluggable — the FMD client and the
     * relayer submitter. The seam for routing SDK egress through a proxy,
     * SOCKS agent or recording shim. Ignored for pre-built pluggables.
     */
    fetchImpl?: typeof fetch | undefined;

    /** Required if `noteSource` is not provided. */
    fmdUrl?: string | undefined;
    /** Required if `submitter` is not provided. */
    relayerUrl?: string | undefined;
    /** Required if `prover` is not provided. */
    proverPaths?: ProverPaths | undefined;

    /** Defaults to in-memory. */
    noteStore?: NoteStore | undefined;
    /** Defaults to fmd-webserver. */
    noteSource?: NoteSource | undefined;
    /** Defaults to a TreeStore backed by fmd-webserver commitment chunks. */
    treeStore?: TreeStore | undefined;
    /**
     * Plug in a persistence backend (e.g. IndexedDB) to resume sync across
     * page loads. Ignored when `treeStore` is provided directly.
     */
    treePersistence?: TreePersistence | undefined;
    /** Defaults to a NullifierStore backed by fmd-webserver nullifier chunks. */
    nullifierStore?: NullifierStore | undefined;
    /** As `treePersistence`, for the spent set. Ignored when `nullifierStore` is set. */
    nullifierPersistence?: NullifierPersistence | undefined;
    /** Default `{ kind: "full" }`. */
    syncStrategy?: SyncStrategy | undefined;
    /** Defaults to HTTP relayer. */
    submitter?: Submitter | undefined;
    /** Defaults to the WASM prover (snarkjs fallback on wasm load failure). */
    prover?: Prover | undefined;
    /** Defaults to SFRT. */
    selector?: CoinSelector | undefined;
    /**
     * Defaults to `LocalScanner`. Use `WorkerPoolScanner` for parallel
     * off-main-thread scan.
     */
    scanner?: Scanner | undefined;
}

/**
 * `WalletConfig` after `connect()` has filled in every default.
 *
 * `WalletConfig` is all-optional because a caller may omit anything. Marking
 * the resolved pluggables required here lets `Wallet` read them without a
 * cast, so the compiler checks the wiring instead of an assertion.
 */
export interface ResolvedWalletConfig extends WalletConfig {
    shape: CircuitShape;
    noteStore: NoteStore;
    noteSource: NoteSource;
    treeStore: TreeStore;
    nullifierStore: NullifierStore;
    submitter: Submitter;
    prover: Prover;
    selector: CoinSelector;
    scanner: Scanner;
}
