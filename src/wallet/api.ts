// Public Wallet API types. `Wallet` in `./index.ts` is the default impl.

import type { SpendingKey } from "../keys.js";
import type { SwapQuote } from "../swap.js";
import type { ChainAdapter } from "./chain-adapter.js";
import type { NoteSource } from "./note-source.js";
import type { NoteStore } from "./note-store.js";
import type { Prover } from "./prover.js";
import type { Scanner } from "./scanner.js";
import type { CoinSelector, SelectionResult, SelectOpts } from "./selection.js";
import type { Submitter } from "./submitter.js";
import type { SyncProgress, SyncResult } from "./sync.js";

export type DepositPhase = "signing" | "submitting";
export type SpendPhase = "preparing" | "proving" | "submitting";

/// Shield ERC-20 into the MASP. For native ETH, set `asEth: true`.
export interface DepositOptions {
    /// Amount in circuit units (post-scale-down).
    amount: bigint;
    /// Default 1n.
    asset?: bigint;
    /// Shielded recipient (bech32m). Defaults to own address.
    to?: string;
    /// Unix-seconds. Default `now + 3600`.
    deadline?: bigint;
    /// Native-ETH deposit. Requires the registered WETH asset id; SDK
    /// calls `submitIntentNative` with `msg.value = total`.
    asEth?: boolean;
    /// Errors from callback are swallowed.
    onPhase?: (phase: DepositPhase) => void;
}

/// Unshield WETH note to raw ETH via `MASP.withdrawEth`. Asset id MUST
/// be registered against the chain's WETH.
export interface WithdrawEthOptions {
    to: string;
    amount: bigint;
    /// Asset id of WETH in the MASP registry.
    asset: bigint;
    selectOpts?: SelectOpts;
    /// Self-spend then retry on `InsufficientCoverError`.
    autoConsolidate?: boolean;
    onPhase?: (phase: SpendPhase) => void;
}

/// Shielded transfer. Throws `InsufficientCoverError` if no 1- or 2-note
/// cover exists, unless `autoConsolidate: true`.
export interface TransferOptions {
    /// Recipient bech32m shielded address.
    to: string;
    amount: bigint;
    /// Default 1n.
    asset?: bigint;
    selectOpts?: SelectOpts;
    autoConsolidate?: boolean;
    onPhase?: (phase: SpendPhase) => void;
}

/// Unshield to ERC20. For native ETH use `withdrawEth`. Throws
/// `InsufficientCoverError` on no cover, unless `autoConsolidate: true`.
export interface WithdrawOptions {
    to: string;
    amount: bigint;
    /// Default 1n.
    asset?: bigint;
    selectOpts?: SelectOpts;
    autoConsolidate?: boolean;
    onPhase?: (phase: SpendPhase) => void;
}

/// Atomic shielded swap via SwapWrapper.
export interface SwapOptions {
    assetIn: bigint;
    assetOut: bigint;
    /// Gross publicOut in circuit units of `assetIn`. MASP transfers
    /// `amount * scaleIn` minus protocol fee to the wrapper.
    amount: bigint;
    /// Pre-fetched MetaQuoter quote pinning route + minOut.
    quote: SwapQuote;
    /// SwapWrapper address; bound as leg-1 recipient+relayer and leg-2 payer.
    wrapperAddress: string;
    /// Shielded recipient for B note. Defaults to own.
    bRecipient?: string;
    selectOpts?: SelectOpts;
    autoConsolidate?: boolean;
    onPhase?: (phase: SpendPhase) => void;
}

/// Normalised receipt. Empty arrays / `0n` over `undefined`.
export interface TransactionResult {
    txHash: string;
    /// 0x-hex commitments created by the tx. Always length 2.
    commitments: [string, string];
    /// Note IDs spent. Empty for `deposit`.
    spent: string[];
    /// `0n` on deposit.
    inputSum: bigint;
    sent: bigint;
    change: bigint;
    /// @deprecated Use `commitments`.
    cm: [string, string];
    /// @deprecated Use `spent`.
    spentNoteIds?: string[];
    /// Deposit-only: on-chain intent id from `MASP.submitIntent`.
    intentId?: bigint;
    /// Subset of `commitments` recoverable via this wallet's FMD scan.
    ownCommitments: string[];
    /// Total value of own outputs; pending balance once FMD indexes them.
    ownInflow: bigint;
}

/// Plaintext payload of a recovered note. Cryptographic fields for
/// custom proofs against the low-level builders.
export interface WalletNotePayload {
    asset: bigint;
    value: bigint;
    rho: bigint;
    rcm: bigint;
    rcvDep: bigint;
}

/// Friendly note view returned by `wallet.notes()`.
export interface WalletNote {
    id: string;
    asset: bigint;
    value: bigint;
    spent: boolean;
    firstSeenBlock?: number;
    /// ISO-8601.
    discoveredAt: string;
    /// 0x-hex (32 bytes).
    cm: string;
    /// Decoded payload. Recomputes on each call.
    notePayload(): WalletNotePayload;
}

/// `asset` is required so multi-asset callers can't read across assets.
export interface NotesFilter {
    asset: bigint;
    spent?: boolean;
}

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
}

export type { CoinSelector, SelectionResult, SelectOpts };
