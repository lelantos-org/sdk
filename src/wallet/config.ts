// Wallet runtime configuration. Every external dependency is pluggable.

import type { ChainAdapter } from "../chain/port.js";
import type { DenominationPolicy } from "../core/denominations.js";
import type { FeeOverride } from "../core/fees.js";
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
     * Input/output arity of the transact circuit. Defaults to `DEFAULT_SHAPE`
     * (4×6), which is the only shape the circuits package still publishes keys
     * for — see `core/shape.ts`.
     */
    shape?: CircuitShape | undefined;
    /** SNARK-bound; must equal relayer pipeline signer or contract reverts. */
    relayerAddress: string;
    chain: ChainAdapter;
    /**
     * Replaces the protocol fee rates the pool reports, for every asset.
     * 1 bp = 0.01%.
     *
     * A bare bigint sets both legs; `{ depositBps, withdrawBps }` prices them
     * apart. Applied when an `AssetInfo` is resolved, so it reaches deposit,
     * withdraw, swap and `previewWithdraw` at once and cannot drift between
     * them.
     *
     * For a pool whose rates the SDK cannot read — a fork, a fixture, a chain
     * whose registry is not deployed yet. A wallet that sets this against a
     * live pool will misquote the moment the owner changes a rate.
     */
    feeBps?: FeeOverride | undefined;

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
     * Which withdrawal ladders this wallet uses. Defaults to the built-ins.
     *
     * ```ts
     * denominations: false                       // opt out entirely
     * denominations: new Map([[token, [...]]])   // custom, replacing built-ins
     * ```
     *
     * `false` restores pre-denomination behaviour everywhere: change splits
     * evenly again, `previewWithdraw` reports no ladder, and `redenominate`
     * becomes a no-op. Worth choosing on a chain the built-in table does not
     * cover — a wallet conforming to a ladder nobody else uses is as
     * distinguishable as one ignoring a ladder everyone follows.
     *
     * Applied when an `AssetInfo` is resolved, so it reaches every path at
     * once and cannot drift between them.
     */
    denominations?: DenominationPolicy | undefined;
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
