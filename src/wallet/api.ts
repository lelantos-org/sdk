// The wallet interfaces `connect()` and `connectWatch()` return.
//
// The implementation is a frozen object of closures over a `WalletContext`: methods are
// bound, so `const { sync } = wallet` and `useSyncExternalStore(wallet.subscribe, wallet.state)`
// work. Plumbing (note store, source, scanner, submitter, prover, selector, `markSpent`) is
// reachable only through `walletInternals(wallet)` in `./internal`.
//
// Errors: every method rejects with a `WalletError` (branch on `isWalletError(err, code)` and
// `err.retryable`), except that an `AbortSignal` the caller passed rejects with its own `reason`.

import type { PaymentProof } from "../bundle/payment-proof.js";
import type { ChainReader } from "../chain/port.js";
import type { Hex32, ShieldedAddress, ViewingKeyString } from "../core/brand.js";
import type { NameControllerKey } from "../keys/name-controller.js";
import type { CircuitShape } from "../protocol/shape.js";
import type { AssetRef, OutAmount } from "./assets/amount.js";
import type { AssetInfo } from "./assets/info.js";
import type { AwaitCommitmentsResult } from "./notes/note-cache.js";
import type { PaymentProofTarget } from "./ops/payment-proof.js";
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
    RegisterNameOptions,
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
    RegisterNameResult,
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
    /** `lelantosfvk1…`: also reveals spent notes. `undefined` on an incoming-tier wallet. */
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
    /**
     * `prove`, a submitter that relays generic executions, a `LelantosNameRegistrar` address and a
     * chain layer that reads it. Needs no EOA.
     */
    readonly registerName: boolean;
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

/** A claim link's bearer key, as `WalletApi.claimLinkKey` derives it. */
export interface ClaimLinkKey {
    index: number;
    /** The link account's spending key: the secret the link carries. */
    nsk: bigint;
    /** The address to fund: the link account's address at index 0. */
    address: ShieldedAddress;
}

/**
 * The read surface: what a viewing key can do. `connectWatch()` returns it; {@link WalletApi}
 * extends it.
 *
 * Amounts are branded circuit units; format with `formatAmount(x, await wallet.asset(ref))`.
 */
export interface ReadOnlyWalletApi {
    /** The account's address at index 0, `lelantos1…`. Equal to `addressAt(0)`. */
    readonly address: ShieldedAddress;
    /**
     * The account's address at `index`. A function of the viewing key and the index, so it is
     * the same on every device and on a watch wallet of the account.
     *
     * Every address receives into this wallet with nothing to register: `sync()` finds a note
     * sent to any of them. Addresses of one account are unlinkable to anyone holding neither its
     * viewing key nor its detection key, so giving each payer its own index keeps payers from
     * recognising a shared payee.
     *
     * Rejects `INVALID_ARGUMENT` unless `index` is an integer in `[0, 2^32)`.
     */
    addressAt(index: number): Promise<ShieldedAddress>;
    /**
     * The address this account publishes under its handle: `addressAt(PUBLISHED_DIVERSIFIER_INDEX)`.
     * Hand out any other index for everything else, so nothing given to a payer can be matched to
     * the published address.
     */
    publishedAddress(): Promise<ShieldedAddress>;
    readonly keys: WalletKeys;
    /** `false` for an incoming-tier key: every note reads unspent; balances are gross received. */
    readonly spentKnown: boolean;
    readonly shape: CircuitShape;

    /** Queued behind a sync in progress. */
    sync(opts?: SyncOptions): Promise<SyncReport>;
    /** Sync until every commitment is stored. Resolves a status; see `throwOnTimeout`. */
    awaitCommitments(
        cms: readonly (Hex32 | string)[],
        opts?: AwaitCommitmentsOptions,
    ): Promise<AwaitCommitmentsResult>;
    /**
     * Whether the pool itself published `commitment` in the mined transaction `txHash`, read from
     * that transaction's receipt over the wallet's own RPC.
     *
     * Notes come from an indexer, and anyone who knows an address can encrypt a well-formed note
     * to it, so a note in `notes()` shows what the indexer served, not what the pool holds. A
     * payee crediting a payment on a receipt (`{ txHash, commitment }`) should require both: the
     * note, for its asset and value, and this, for its existence. `false` for a transaction that
     * does not carry it, including a deposit's escrow, which is not in the tree until flushed.
     *
     * With the default reader, a hash the node holds no receipt for is waited on for a bounded
     * time (15 s) and then rejects `TX_MINING`, which is retryable; it never resolves `false`.
     * Rejects `UNSUPPORTED_OPERATION` when the wallet has no chain layer that reads receipts.
     */
    confirmCommitment(commitment: Hex32 | string, txHash: Hex32 | string): Promise<boolean>;

    /** The current snapshot. Same object until the next change. */
    state(): WalletState;
    /**
     * Called with each new snapshot after a change commits (sync start/end, notes added, spent,
     * pending or compacted, an op starting, changing phase or settling, dispose), coalesced to one
     * call per microtask. Not called on subscribe. Returns an idempotent unsubscribe. A throwing
     * listener is logged and swallowed.
     */
    subscribe(listener: StateListener): () => void;

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

    /** Drop spent notes from the store. */
    compact(): Promise<{ removed: number }>;
    /**
     * Release what the SDK built for this wallet: the scanner workers and prover it created from
     * a `ScannerOption` / `ProverConfig`. A `Scanner` or `Prover` instance passed to `connect` /
     * `createWallet` is not disposed (the caller owns it and may share it across wallets), and
     * stores and persistence backends are never closed. Idempotent; every method but `state` /
     * `subscribe` / `dispose` then rejects `UNSUPPORTED_OPERATION`.
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

    /** Relayer fee for `kind` and the assets it accepts. `native` prices the native path. */
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

    transfer(args: TransferOptions): Promise<TransferResult>;
    /**
     * A proof, for a third party, of one payment this wallet made. Whoever holds it and the
     * payee's address learns that output's asset and value (`verifyPaymentProof`) and nothing
     * else; give it only to them.
     *
     * The target names the output and what it paid, each field from the spend's
     * `TransferResult`: `txHash`, `commitment` (`recipientCommitment`), `recipient`, `asset`
     * (`amount.asset`) and `amount` (`amount.amount`, circuit units). The proof is recomputed
     * from those, the account's key and the chain, so it can be made at any time, on any device.
     *
     * Rejects `INVALID_ARGUMENT` when the transaction did not publish `commitment`, which
     * includes a transaction the node holds no receipt for, or when the account's key with
     * `recipient`, `asset` and `amount` does not reproduce the output (another wallet made it, or
     * it paid a different recipient, asset or amount). Rejects `UNSUPPORTED_OPERATION` unless the
     * chain layer has both `fetchNotePayload` and `txReceiptLogs`.
     */
    paymentProof(target: PaymentProofTarget): Promise<PaymentProof>;
    /**
     * The spending key and address of this account's `index`-th claim link on this chain: a
     * fresh account to fund and hand over as a bearer link. Derived from the seed, so a link the
     * payee never opens can be recomputed and swept back from any device.
     *
     * An index must fund at most one link: two links from one index share a key, so the holder
     * of the first can take the second. Use the first index whose account has never held a note.
     */
    claimLinkKey(index: number): Promise<ClaimLinkKey>;
    withdraw(args: WithdrawOptions): Promise<WithdrawResult>;
    swap(args: SwapOptions): Promise<SwapResult>;
    /**
     * Claim a handle, paid from shielded funds, publishing `publishedAddress()` under it.
     *
     * The handle and the address become public and stay in chain history. No EVM account is named:
     * the handle belongs to `nameControllerKey()`. Resolves once the relayer landed the
     * transaction; `registered` says whether the handle was claimed or the input refunded.
     *
     * Rejects `INVALID_ARGUMENT` (`argument: "label"`) for a label that is malformed or already
     * registered, and `UNSUPPORTED_OPERATION` without `capabilities.registerName`.
     */
    registerName(args: RegisterNameOptions): Promise<RegisterNameResult>;
    /**
     * The key that controls this account's handle. Its signature changes or clears the published
     * value, and a cancelled escrow of a registration refunds to its address. Derived from the
     * seed, so it is the same on every device.
     */
    nameControllerKey(): Promise<NameControllerKey>;
    /** Re-split off-ladder notes onto the ladder; returns rounds run. Best-effort. */
    redenominate(
        asset: AssetRef,
        opts?: OpOptions<SpendPhase> & { maxRounds?: number | undefined },
    ): Promise<number>;
}
