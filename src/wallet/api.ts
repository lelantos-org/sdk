// Public Wallet API surface — types only.
//
// `WalletApi` is the seam apps mock in tests; `Wallet` (in `./index.ts`)
// is the default implementation. Splitting types out of the impl keeps
// the import graph shallow for consumers that need only the shape.

import type { SpendingKey } from "../keys.js";
import type { ChainAdapter } from "./chain-adapter.js";
import type { NoteSource } from "./note-source.js";
import type { NoteStore, StoredNote } from "./note-store.js";
import type { Prover } from "./prover.js";
import type { Scanner } from "./scanner.js";
import type { CoinSelector, SelectionResult, SelectOpts } from "./selection.js";
import type { Submitter } from "./submitter.js";
import type { SyncProgress, SyncResult } from "./sync.js";

/// Per-op progress phases. Mirrors `SyncProgress.phase`. Surfaced via
/// `onPhase` callbacks on each op's options so UIs can render a stepper.
export type DepositPhase = "signing" | "submitting";
export type SpendPhase = "preparing" | "proving" | "submitting";

/// Args for `Wallet.deposit`. Shields an ERC-20 from caller's eth account
/// into the MASP. Caller must hold an EIP-2612-permit-capable ERC-20
/// balance ≥ `amount * scale + fee`. For native ETH, use `depositEth`.
export interface DepositOptions {
    /// Amount in *circuit units* (post-scale-down). Multiplied by the
    /// asset's `scale` to get the ERC-20 base-unit deposit.
    amount: bigint;
    /// Asset id (default 1n).
    asset?: bigint;
    /// Shielded recipient (bech32m). Defaults to own address (deposit to self).
    to?: string;
    /// EIP-2612 permit deadline (unix-seconds). Default: `now + 3600`.
    deadline?: bigint;
    /// Native-ETH deposit. When true, the asset must be the registered WETH
    /// id; SDK calls `chain.submitIntentNative` with `msg.value = total` and
    /// skips Permit2 entirely. Caller must have native ETH balance ≥ total.
    asEth?: boolean;
    /// Progress callback fired before each major step. Useful for UIs that
    /// want to render a stepper. Errors thrown from this callback are
    /// swallowed so they don't break the op.
    onPhase?: (phase: DepositPhase) => void;
}

/// Args for `Wallet.withdrawEth`. Unshields a WETH-asset note and forwards
/// raw ETH to `to` via `MASP.withdrawEth` (unwraps inside the contract).
/// The selected asset id MUST be registered against the chain's WETH.
export interface WithdrawEthOptions {
    /// On-chain ETH recipient (0x address). Must be EOA or payable contract.
    to: string;
    /// Amount in circuit units.
    amount: bigint;
    /// Asset id of WETH in the MASP registry.
    asset: bigint;
    /// Optional selection tuning.
    selectOpts?: SelectOpts;
    /// On `InsufficientCoverError`, transparently self-spend then retry.
    autoConsolidate?: boolean;
    /// Progress callback for stepper UIs. See `DepositOptions.onPhase`.
    onPhase?: (phase: SpendPhase) => void;
}

/// Args for `Wallet.transfer`. Spends 1-2 unspent notes covering `amount`
/// and creates a send-note for `to` plus a change-note back to self.
/// Throws `InsufficientCoverError` if no 1- or 2-note cover exists, unless
/// `autoConsolidate: true` is set.
export interface TransferOptions {
    /// Recipient bech32m shielded address (any wallet, including own).
    to: string;
    /// Amount in circuit units.
    amount: bigint;
    /// Asset id (default 1n).
    asset?: bigint;
    /// Optional selection tuning (fee, dust threshold, RNG, etc.).
    selectOpts?: SelectOpts;
    /// On `InsufficientCoverError`, transparently self-spend the two
    /// smallest notes, re-sync, and retry the transfer once. Default false.
    autoConsolidate?: boolean;
    /// Progress callback for stepper UIs. See `DepositOptions.onPhase`.
    onPhase?: (phase: SpendPhase) => void;
}

/// Args for `Wallet.withdraw`. Spends 1-2 notes; releases `amount` ERC20
/// to `to` on-chain; remainder split into two change-notes back to self.
/// For native ETH unshield, use `withdrawEth`. Throws
/// `InsufficientCoverError` on no cover, unless `autoConsolidate: true` is
/// set.
export interface WithdrawOptions {
    /// On-chain ERC-20 recipient (0x address).
    to: string;
    /// Amount in circuit units.
    amount: bigint;
    /// Asset id (default 1n).
    asset?: bigint;
    /// Optional selection tuning.
    selectOpts?: SelectOpts;
    /// On `InsufficientCoverError`, transparently self-spend the two
    /// smallest notes, re-sync, and retry the withdraw once. Default false.
    autoConsolidate?: boolean;
    /// Progress callback for stepper UIs. See `DepositOptions.onPhase`.
    onPhase?: (phase: SpendPhase) => void;
}

/// Normalised receipt returned by `deposit` / `transfer` / `withdraw`. All
/// fields are always populated (empty arrays / `0n` instead of
/// `undefined`) so consumers can drop the optional-chaining boilerplate.
export interface TransactionResult {
    /// On-chain transaction hash.
    txHash: string;
    /// Commitments created by the transaction (0x-hex). Always length 2.
    commitments: [string, string];
    /// Note IDs spent by this transaction. Empty for `deposit`.
    spent: string[];
    /// Total input value (`0n` on deposit).
    inputSum: bigint;
    /// Value sent to the recipient (deposit/transfer/withdraw amount).
    sent: bigint;
    /// Value returned to the wallet as change.
    change: bigint;
    /// @deprecated Use `commitments`. Tuple alias kept for back-compat.
    cm: [string, string];
    /// @deprecated Use `spent`. Old optional alias kept for back-compat.
    spentNoteIds?: string[];
    /// Deposit-only: the on-chain intent id allocated by `MASP.submitIntent`.
    /// Webapp consumers track flush status by this id over the relayer SSE
    /// stream. Undefined for spend ops.
    intentId?: bigint;
    /// Subset of `commitments` that this wallet expects to recover via FMD
    /// scan (own change / self-deposit notes). Empty for transfers where
    /// neither output goes to self. Use with `wallet.awaitCommitments`.
    ownCommitments: string[];
    /// Total value (in circuit units) of the produced outputs flagged as
    /// own. Equals the amount that will land back in the local wallet
    /// once the FMD scanner indexes them. UIs use this to render an
    /// "incoming" pending balance until those notes are observed.
    ownInflow: bigint;
}

/// Friendly note view returned by `wallet.notes()`. Internal storage uses
/// decimal-string `bigint`s + 0x-hex `cm`; this view exposes native
/// `bigint`s and a `.raw` accessor for callers that need the storage form.
export interface WalletNote {
    /// Stable short id assigned by the SDK on discovery.
    id: string;
    /// Native bigint asset id.
    asset: bigint;
    /// Native bigint value (in circuit units).
    value: bigint;
    /// Whether the note has been spent on chain.
    spent: boolean;
    /// First chain block at which the note was observed (when known).
    firstSeenBlock?: number;
    /// Wall-clock discovery time (ISO-8601).
    discoveredAt: string;
    /// 0x-hex commitment (32 bytes).
    cm: string;
    /// Raw `StoredNote` (decimal strings, hex), useful for serialisation.
    raw: StoredNote;
}

/// Filter for `wallet.notes()`. `asset` is required so callers in
/// multi-asset deployments can't accidentally read across assets.
export interface NotesFilter {
    asset: bigint;
    spent?: boolean;
}

/// Public interface — apps can mock this in tests, or build alternative
/// implementations (HSM-backed wallet, multi-sig, MPC) without subclassing.
export interface WalletApi {
    readonly address: string;
    readonly keys: SpendingKey;
    readonly noteStore: NoteStore;
    /// Active chain adapter — exposed for token lookups, balance reads,
    /// and any direct RPC needs. Cast to your adapter's concrete type
    /// (e.g. `EthersChainAdapter`) for adapter-specific accessors.
    readonly chain: ChainAdapter;
    /// Active pluggables. Useful for tooling that wants to wrap them with
    /// timing / retry / observability (see CLI's `instrumentWallet`).
    readonly noteSource: NoteSource;
    readonly submitter: Submitter;
    readonly prover: Prover;
    readonly scanner: Scanner;
    readonly selector: CoinSelector;

    sync(opts?: { limit?: number; onProgress?: (p: SyncProgress) => void }): Promise<SyncResult>;
    refresh(): Promise<void>;
    /// Block until every commitment in `cms` is present in the local note
    /// store, polling `sync()` between attempts. Resolves immediately if
    /// they're already there. Use `signal` to cancel; `pollMs` controls
    /// backoff between sync calls.
    awaitCommitments(
        cms: string[],
        opts?: { signal?: AbortSignal; pollMs?: number; maxAttempts?: number },
    ): Promise<void>;
    /// Friendly note view filtered by asset. `spent` is optional; omit to
    /// include both spent + unspent.
    notes(filter: NotesFilter): WalletNote[];
    /// Same view, but across all assets — for dashboards / multi-asset
    /// summaries. `spent` filters spent / unspent (omit for both).
    allNotes(filter?: { spent?: boolean }): WalletNote[];
    /// Unspent balance for `asset`.
    balance(asset: bigint): bigint;
    selectNotes(asset: bigint, target: bigint, opts?: SelectOpts): SelectionResult;

    deposit(args: DepositOptions): Promise<TransactionResult>;
    transfer(args: TransferOptions): Promise<TransactionResult>;
    withdraw(args: WithdrawOptions): Promise<TransactionResult>;
    /// Unshield to raw ETH via the WETH bridge.
    withdrawEth(args: WithdrawEthOptions): Promise<TransactionResult>;
    markSpent(noteIds: string[]): Promise<void>;
}

export type { CoinSelector, SelectionResult, SelectOpts };
