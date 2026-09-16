// The wallet interfaces `connect()` and `connectWatch()` return.
//
// The implementation is a frozen object of closures over a `WalletContext`: methods are
// bound, so `const { sync } = wallet` and `useSyncExternalStore(wallet.subscribe, wallet.state)`
// work. Plumbing (note store, source, scanner, submitter, prover, selector, `markSpent`) is
// reachable only through `walletInternals(wallet)` in `./internal`.
//
// Errors: every method rejects with a `WalletError` (branch on `isWalletError(err, code)` and
// `err.retryable`), except that an `AbortSignal` the caller passed rejects with its own `reason`.

import type { ChainReader } from "../chain/port.js";
import type { Hex32, ShieldedAddress, ViewingKeyString } from "../core/brand.js";
import type { CircuitShape } from "../protocol/shape.js";
import type { AssetRef, OutAmount } from "./assets/amount.js";
import type { AssetInfo } from "./assets/info.js";
import type { AwaitCommitmentsResult } from "./notes/note-cache.js";
import type { DenominationChoice, WithdrawPreview } from "./ops/withdraw-preview.js";
import type { SpendableMax } from "./selection/index.js";
import type {
    AllowanceSetupOptions,
    CancelDepositTarget,
    DepositOptions,
    DepositPhase,
    NotesFilter,
    OpOptions,
    QuoteSwapOptions,
    SelectionOptions,
    SpendPhase,
    SwapOptions,
    TransferOptions,
    WithdrawOptions,
} from "./types/options.js";
import type { DepositQuote, FeeKind, FeeQuote, SwapQuote } from "./types/quotes.js";
import type {
    CancelDepositResult,
    DepositEscrow,
    DepositResult,
    SwapResult,
    TransferResult,
    WalletNote,
    WithdrawResult,
} from "./types/results.js";
import type {
    AwaitCommitmentsOptions,
    Balance,
    StateListener,
    SyncOptions,
    SyncReport,
    WalletState,
} from "./types/sync.js";

export type { DenominationChoice, NotesFilter, SpendableMax, WalletNote, WithdrawPreview };

/**
 * The key material a wallet can hand out, bech32m-encoded.
 *
 * Raw key objects (including `nsk`) are not on the public surface; `walletInternals(w).keys` has
 * them for custom proofs.
 */
export interface WalletKeys {
    /**
     * `"incoming"`: detects incoming notes only. `"full"`: also recomputes nullifiers, so sees
     * spends. `"spending"`: full, plus spend authority (held internally, never exposed).
     */
    readonly tier: "incoming" | "full" | "spending";
    /** `lelantosivk1…`: lets a holder see incoming notes. */
    readonly viewingKey: ViewingKeyString;
    /** `lelantosfvk1…`: also reveals which notes are spent. `undefined` on an incoming-tier wallet. */
    readonly fullViewingKey: ViewingKeyString | undefined;
}

/** {@link WalletKeys} of a wallet holding spend authority. */
export interface SpendingWalletKeys extends WalletKeys {
    readonly tier: "spending";
    readonly fullViewingKey: ViewingKeyString;
}

/**
 * What this wallet can do, fixed at `connect()` from its configuration. A `false` flag's methods
 * stay on the interface and reject with the code noted.
 */
export interface WalletCapabilities {
    /** A prover is configured (`prover` ≠ `"none"`). Else spends reject `PROVER_UNAVAILABLE`. */
    readonly prove: boolean;
    /** The chain layer signs as an EOA. Else deposit / cancel / setup reject `NO_EVM_ACCOUNT`. */
    readonly deposit: boolean;
    /** The adapter supports Permit2 batch AllowanceTransfer (`setupDepositAllowance`). */
    readonly depositAllowance: boolean;
    /** `deposit({ native: true })`. Else `UNSUPPORTED_OPERATION`. */
    readonly nativeDeposit: boolean;
    /** `withdraw({ native: true })`: a `NativeAdapter` is known. Needs no EOA. */
    readonly nativeWithdraw: boolean;
    /**
     * `prove`, a submitter that relays swaps, and a quoter URL. A relayer advertising no wrapper
     * still rejects `quoteSwap` with `UNSUPPORTED_OPERATION`.
     */
    readonly swap: boolean;
}

/** `spendableMax` options. */
export interface SpendableMaxOptions {
    /**
     * Reserve the relayer fee for this kind: taken from the maximum when paid in `asset`, or one
     * input slot when paid in another. Omitted: nothing is reserved.
     */
    kind?: FeeKind | undefined;
    /** With `kind`: the fee asset the spend will name. Default `asset`. */
    feeAsset?: AssetRef | undefined;
    /** With `kind: "withdraw"`: price the native-unwrap estimate. */
    native?: boolean | undefined;
    selection?: SelectionOptions | undefined;
}

/**
 * The read surface: what a viewing key can do. `connectWatch()` returns it; {@link WalletApi}
 * extends it.
 *
 * Amounts are branded circuit units; format with `formatAmount(x, await wallet.asset(ref))`.
 */
export interface ReadOnlyWalletApi {
    readonly address: ShieldedAddress;
    readonly keys: WalletKeys;
    /** `false` for an incoming-tier key: every note reads unspent and balances are gross received. */
    readonly spentKnown: boolean;
    readonly shape: CircuitShape;

    // --- sync --------------------------------------------------------------------------------
    /** Queued behind a sync in progress. */
    sync(opts?: SyncOptions): Promise<SyncReport>;
    /** Sync until every commitment is stored. Resolves a status; see `throwOnTimeout`. */
    awaitCommitments(
        cms: readonly (Hex32 | string)[],
        opts?: AwaitCommitmentsOptions,
    ): Promise<AwaitCommitmentsResult>;

    // --- observe -----------------------------------------------------------------------------
    /** The current snapshot. Same object until the next change. */
    state(): WalletState;
    /**
     * Called with each new snapshot after a change commits (sync start/end, notes added, spent,
     * pending or compacted, an op starting, changing phase or settling, dispose), coalesced to one
     * call per microtask. Not called on subscribe. Returns an idempotent unsubscribe. A throwing
     * listener is logged and swallowed.
     */
    subscribe(listener: StateListener): () => void;

    // --- read --------------------------------------------------------------------------------
    balance(asset: AssetRef): Promise<Balance>;
    notes(filter?: NotesFilter): Promise<WalletNote[]>;
    /** Chain-verified registry entry; cached briefly, `refresh` re-reads. */
    asset(ref: AssetRef, opts?: { refresh?: boolean | undefined }): Promise<AssetInfo>;
    /** Every registered asset, for display: the relayer's list, not verified against the chain. */
    assets(): Promise<AssetInfo[]>;
    /** What a withdrawal would publish, charge and deliver. Pure over the asset. */
    previewWithdraw(args: { asset: AssetRef } & OutAmount): Promise<WithdrawPreview>;
    /** The asset's denominations, labelled for a picker; `[]` without a ladder. */
    withdrawDenominations(asset: AssetRef): Promise<DenominationChoice[]>;

    // --- lifecycle ---------------------------------------------------------------------------
    /** Drop spent notes from the store. */
    compact(): Promise<{ removed: number }>;
    /**
     * Release what the SDK built for this wallet: the scanner workers and prover it created from
     * a `ScannerOption` / `ProverConfig`. A `Scanner` or `Prover` instance passed to `connect` /
     * `createWallet` is not disposed (its lifetime stays with the caller, so it can be shared
     * across wallets), and stores and persistence backends are never closed. Idempotent; every
     * method but `state` / `subscribe` / `dispose` then rejects `UNSUPPORTED_OPERATION`.
     */
    dispose(): Promise<void>;
    [Symbol.asyncDispose](): Promise<void>;
}

/** A wallet holding spend authority. `connect()` returns it, whatever the chain layer. */
export interface WalletApi extends ReadOnlyWalletApi {
    readonly keys: SpendingWalletKeys;
    /** Narrow with `supportsSigning` / `supportsAllowanceTransfer` for adapter-specific reads. */
    readonly chain: ChainReader;
    readonly capabilities: WalletCapabilities;

    /** Fetch and warm the prover now rather than at the first spend. */
    warmProver(opts?: { signal?: AbortSignal | undefined }): Promise<void>;

    // --- quotes ------------------------------------------------------------------------------
    /** Relayer fee for `kind` and the assets it accepts. `native` prices the native-path estimate. */
    quoteFee(
        kind: FeeKind,
        opts?: { native?: boolean | undefined; signal?: AbortSignal | undefined },
    ): Promise<FeeQuote>;
    /**
     * The largest `amount` (transfer) or `gross` (withdraw, swap) one spend can cover, by the same
     * rules the spend applies.
     */
    spendableMax(asset: AssetRef, opts?: SpendableMaxOptions): Promise<SpendableMax>;
    quoteDeposit(args: DepositOptions): Promise<DepositQuote>;
    quoteSwap(args: QuoteSwapOptions): Promise<SwapQuote>;

    // --- deposit -----------------------------------------------------------------------------
    deposit(args: DepositOptions): Promise<DepositResult>;
    /** Await the relayer's flush: `awaitCommitments([escrow.commitment])`. */
    awaitDeposit(
        escrow: DepositEscrow,
        opts?: AwaitCommitmentsOptions,
    ): Promise<AwaitCommitmentsResult>;
    /** Reclaim an unflushed escrow once cancellable; routes native escrows through the adapter. */
    cancelDeposit(
        target: CancelDepositTarget,
        opts?: OpOptions<DepositPhase>,
    ): Promise<CancelDepositResult>;
    setupDepositAllowance(args: AllowanceSetupOptions): Promise<void>;

    // --- spend -------------------------------------------------------------------------------
    transfer(args: TransferOptions): Promise<TransferResult>;
    withdraw(args: WithdrawOptions): Promise<WithdrawResult>;
    swap(args: SwapOptions): Promise<SwapResult>;
    /** Re-split off-ladder notes onto the ladder; returns rounds run. Best-effort. */
    redenominate(
        asset: AssetRef,
        opts?: OpOptions<SpendPhase> & { maxRounds?: number | undefined },
    ): Promise<number>;
}
