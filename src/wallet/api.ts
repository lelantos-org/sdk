// Public Wallet API interface. Options live in `./options.ts`, results in
// `./result.ts`. `Wallet` in `./wallet.ts` is the default impl.

import type { ChainAdapter } from "../chain/adapter.js";
import type { SpendingKey } from "../keys/keys.js";
import type { Prover } from "../prover/interface.js";
import type { Scanner } from "../sync/scanner.js";
import type { NoteSource } from "./note-source.js";
import type { NoteStore } from "./note-store.js";
import type {
    DepositOptions,
    NotesFilter,
    SwapOptions,
    TransferOptions,
    WithdrawEthOptions,
    WithdrawOptions,
} from "./options.js";
import type { TransactionResult, WalletNote } from "./result.js";
import type { CoinSelector, SelectionResult, SelectOpts } from "./selection.js";
import type { Submitter } from "./submitter.js";
import type { SyncProgress, SyncResult } from "./sync.js";

export interface WalletApi {
    readonly address: string;
    readonly keys: SpendingKey;
    readonly noteStore: NoteStore;
    /// Cast to a concrete adapter type for adapter-specific accessors.
    readonly chain: ChainAdapter;
    readonly noteSource: NoteSource;
    readonly submitter: Submitter;
    readonly prover: Prover;
    readonly scanner: Scanner;
    readonly selector: CoinSelector;

    /// Pull encrypted notes only. Sufficient for balance display; does not sync the Merkle tree.
    syncNotes(opts?: {
        limit?: number;
        onProgress?: (p: SyncProgress) => void;
    }): Promise<SyncResult>;
    /// Fetch new Merkle commitment chunks and rebuild the local tree. Required before spending.
    syncTree(): Promise<void>;
    /// Pull notes and sync the tree in parallel. Convenience wrapper around `syncNotes` + `syncTree`.
    sync(opts?: { limit?: number; onProgress?: (p: SyncProgress) => void }): Promise<SyncResult>;
    refresh(): Promise<void>;
    /// Block until every commitment in `cms` is in the local store,
    /// polling `sync()` between attempts.
    awaitCommitments(
        cms: string[],
        opts?: { signal?: AbortSignal; pollMs?: number; maxAttempts?: number },
    ): Promise<void>;
    /// Omit `spent` to include both.
    notes(filter: NotesFilter): WalletNote[];
    /// Cross-asset view for dashboards.
    allNotes(filter?: { spent?: boolean }): WalletNote[];
    balance(asset: bigint): bigint;
    selectNotes(asset: bigint, target: bigint, opts?: SelectOpts): SelectionResult;

    deposit(args: DepositOptions): Promise<TransactionResult>;
    transfer(args: TransferOptions): Promise<TransactionResult>;
    withdraw(args: WithdrawOptions): Promise<TransactionResult>;
    /// Unshield to raw ETH via the WETH bridge.
    withdrawEth(args: WithdrawEthOptions): Promise<TransactionResult>;
    /// Atomic shielded swap; legs bundled via `submitter.submitSwap`.
    swap(args: SwapOptions): Promise<TransactionResult>;
    markSpent(noteIds: string[]): Promise<void>;
    /// Drop notes flagged `spent: true` from the underlying store. Returns
    /// the number of notes pruned. Balance is unaffected; this only shrinks
    /// the on-disk file. Live notes and reconcile state are preserved.
    compact(): Promise<{ removed: number }>;
}

// Re-export option, result, and selection types so existing
// `import { ... } from "./api.js"` callers keep working.
export type {
    DepositOptions,
    DepositPhase,
    NotesFilter,
    OnPhase,
    SpendPhase,
    SwapOptions,
    TransferOptions,
    WithdrawEthOptions,
    WithdrawOptions,
} from "./options.js";
export type {
    DepositResult,
    SwapResult,
    TransactionResult,
    TransferResult,
    WalletNote,
    WalletNotePayload,
    WithdrawResult,
} from "./result.js";
export type { CoinSelector, SelectionResult, SelectOpts };
