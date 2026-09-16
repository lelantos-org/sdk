// Wallet runtime configuration. Every external dependency is pluggable.

import type { ChainReader } from "../../chain/port.js";
import type { DenominationPolicy } from "../../protocol/denominations.js";
import type { FeeOverride } from "../../protocol/fees.js";
import type { CircuitShape } from "../../protocol/shape.js";
import type { Prover } from "../../prover/types.js";
import type { Submitter } from "../../services/relayer/submitter.js";
import type { NoteSource } from "../../sync/note-source.js";
import type { NullifierPersistence, NullifierStore } from "../../sync/nullifier-store.js";
import type { Scanner } from "../../sync/scanner.js";
import type { TreePersistence, TreeStore } from "../../sync/tree-store.js";
import type { HttpOptions, ProverConfig } from "../connect/options.js";
import type { NoteStore } from "../notes/note-store.js";
import type { CoinSelector } from "../selection/index.js";

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
     * (4×6), the only shape the circuits package publishes keys for; see
     * `protocol/shape.ts`.
     */
    shape?: CircuitShape | undefined;
    /**
     * SNARK-bound as `pi.relayer` (and a swap's `pi_w.payer`). Must be the
     * submitter address the relayer publishes on `/chains`: its `Bundler`
     * contract where it bundles, not its signing EOA. Any other value reverts on
     * chain.
     */
    relayerAddress: string;
    chain: ChainReader;
    /**
     * Replaces the protocol fee rates the pool reports, for every asset.
     * 1 bp = 0.01%.
     *
     * A bigint sets both legs; `{ depositBps, withdrawBps }` sets them
     * separately. Applied when an `AssetInfo` is resolved, so deposit, withdraw,
     * swap and `previewWithdraw` all use the same rates.
     *
     * Intended for pools whose rates the SDK cannot read: forks, fixtures, or
     * chains without a deployed registry. Against a live pool, quotes become
     * wrong as soon as the owner changes a rate.
     */
    feeBps?: FeeOverride | undefined;

    /**
     * Transport options for every default HTTP pluggable (the FMD client, the
     * relayer submitter and the quoter): `fetch`, timeouts, retries, `onRetry`
     * and extra headers. Ignored for pre-built pluggables.
     */
    http?: HttpOptions | undefined;
    /** MetaQuoter base URL. Without it the wallet's `capabilities.swap` is `false`. */
    quoterUrl?: string | undefined;
    /** `SwapWrapper`. Else read from the relayer's `/chains`. */
    swapWrapperAddress?: string | undefined;

    /** Required if `noteSource` is not provided. */
    fmdUrl?: string | undefined;
    /** Required if `submitter` is not provided. */
    relayerUrl?: string | undefined;
    /**
     * Per-attempt submit deadline, in ms, for the default relayer submitter on
     * this chain. See `NetworkPreset.submitTimeoutMs`. Default 30 000. Ignored
     * when `submitter` is provided.
     */
    submitTimeoutMs?: number | undefined;
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
    /**
     * A `Prover`, a {@link ProverConfig} the wallet builds one from, or `"none"` (spends reject
     * `PROVER_UNAVAILABLE`). Default `{ warmup: "lazy" }` over the bundled
     * artifacts: nothing is fetched until the first proof.
     */
    prover?: Prover | ProverConfig | "none" | undefined;
    /** Defaults to SFRT. */
    selector?: CoinSelector | undefined;
    /**
     * Whether this wallet uses withdrawal ladders. Defaults to `true`.
     *
     * Each asset's ladder is derived from its `scale` and `decimals`, so no
     * per-token configuration is needed; see `protocol/denominations`.
     *
     * `false` disables ladders everywhere: change splits evenly,
     * `previewWithdraw` reports no ladder, and `redenominate` is a no-op. This
     * is the only case in which an asset has no ladder.
     *
     * Applied when an `AssetInfo` is resolved, so every path uses the same
     * policy.
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
 * Marks the resolved pluggables required so the wallet reads them without a
 * cast and the compiler checks the wiring.
 */
export interface ResolvedWalletConfig extends Omit<WalletConfig, "prover"> {
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
