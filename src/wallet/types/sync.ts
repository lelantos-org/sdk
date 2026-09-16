// Sync, balances and observable wallet state.

import type { AssetId, CircuitAmount } from "../../core/brand.js";
import type { WalletError } from "../../errors/base.js";
import type { SyncResult } from "../../sync/notes-sync.js";
import type { NullifierSyncSummary } from "../../sync/nullifier-store.js";
import type { TreeSyncSummary } from "../../sync/tree-store.js";
import type { AssetInfo } from "../assets/info.js";
import type { WithheldValue } from "../selection/index.js";
import type { Phase } from "./options.js";

export type { AwaitCommitmentsResult } from "../notes/note-cache.js";
export type { WithheldValue };

// --- sync ----------------------------------------------------------------------------------------

/** Progress of one sync, per stream. A throwing listener is logged and swallowed. */
export type SyncProgress =
    | {
          stream: "notes";
          phase: "fetching" | "scanning" | "persisting" | "done";
          fetched: number;
          hits: number;
      }
    | { stream: "tree"; chunkId: number; leaves: number; syncedCount: number }
    | { stream: "nullifiers"; chunkId: number; added: number; syncedCount: number };

export interface SyncOptions {
    /**
     * - `"full"` (default on a spending wallet): notes, spent set and Merkle tree, then reconcile.
     * - `"notes"`: notes and spent set, then reconcile. Enough for balances; a spend syncs the tree
     *   itself. A watch wallet always syncs `"notes"`.
     */
    scope?: "notes" | "full" | undefined;
    /** Re-read the `NoteStore` first, after another tab or process wrote to it. */
    reload?: boolean | undefined;
    /** Feed page size. Not a cap on what is fetched. */
    pageSize?: number | undefined;
    /** Stops at the next page boundary; progress so far is kept. Rejects with `signal.reason`. */
    signal?: AbortSignal | undefined;
    onProgress?: ((p: SyncProgress) => void) | undefined;
}

/** Notes feed summary. */
export type NotesSyncSummary = SyncResult;

export interface SyncReport {
    notes: NotesSyncSummary;
    /** Present when `scope: "full"`. */
    tree?: TreeSyncSummary | undefined;
    /** Absent on a wallet that cannot recompute nullifiers (`spentKnown: false`). */
    nullifiers?: NullifierSyncSummary | undefined;
    syncedAt: Date;
}

export interface AwaitCommitmentsOptions {
    signal?: AbortSignal | undefined;
    /** Delay between syncs. Default 2 000 ms. */
    pollMs?: number | undefined;
    /** Give up after this long. Default 120 000 ms. */
    timeoutMs?: number | undefined;
    pageSize?: number | undefined;
    /**
     * Reject with `FMD_TIMEOUT` on timeout instead of resolving `{ status: "timeout" }`.
     * Default `false`: a lagging indexer after a landed transaction is not a failure.
     */
    throwOnTimeout?: boolean | undefined;
}

// --- balance -------------------------------------------------------------------------------------

/**
 * One asset's shielded balance, split by what a single spend can reach.
 *
 * `total === spendable + withheld.reserved + withheld.cooldown + withheld.dust + withheld.slots`.
 */
export interface Balance {
    asset: AssetInfo;
    /** Every unspent note. On a `spentKnown: false` wallet, everything ever received. */
    total: CircuitAmount;
    /**
     * What one spend can cover with no fee reserved: `spendableMax(asset).max`. For a fee-aware
     * figure call `spendableMax` with `kind`.
     */
    spendable: CircuitAmount;
    /**
     * - `reserved`: leased by an in-flight spend or pending an unknown outcome;
     * - `cooldown`: arrived too recently (inert without a chain tip);
     * - `dust`: below the dust threshold;
     * - `slots`: beyond the circuit's input arity; merging notes (`autoConsolidate`) recovers it.
     */
    withheld: WithheldValue;
    /** When the notes behind this figure last synced; `undefined` before the first sync. */
    syncedAt: Date | undefined;
}

// --- state ---------------------------------------------------------------------------------------

/** An operation that has started and not yet settled. */
export interface OpActivity {
    opId: string;
    op:
        | "deposit"
        | "cancelDeposit"
        | "setupDepositAllowance"
        | "transfer"
        | "withdraw"
        | "swap"
        | "redenominate";
    /** Latest phase emitted; `undefined` before the first. */
    phase: Phase | undefined;
    startedAt: Date;
}

/**
 * A snapshot of what the wallet knows, for rendering without polling.
 *
 * Immutable. `state()` returns the same object until something changes, so it can back React's
 * `useSyncExternalStore(wallet.subscribe, wallet.state)` directly.
 */
export interface WalletState {
    /** Increments on every emitted change. */
    readonly version: number;
    readonly sync: {
        readonly status: "idle" | "syncing";
        /** Last successful sync. */
        readonly syncedAt: Date | undefined;
        readonly lastReport: SyncReport | undefined;
        /** The last sync's failure, cleared by the next success. */
        readonly lastError: WalletError | undefined;
    };
    readonly notes: {
        /** Notes in the store, spent included. */
        readonly count: number;
        readonly unspent: number;
        /** Reserved after a submit with an unknown outcome. */
        readonly pendingSpend: number;
    };
    /** Unspent total per asset held: `Balance.total`, without the async split. */
    readonly balances: ReadonlyMap<AssetId, CircuitAmount>;
    /** Operations in flight, oldest first. */
    readonly ops: readonly OpActivity[];
    readonly disposed: boolean;
}

/** Receives each new snapshot. */
export type StateListener = (state: WalletState) => void;
