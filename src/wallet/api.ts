// Public Wallet API interface. Options live in `./options.ts`, results in
// `./result.ts`. `Wallet` in `./wallet.ts` is the default impl.

import type { ChainReader } from "../chain/port.js";
import type { CancelDepositInputs } from "../chain/types.js";
import type { AssetId, AssetIdLike, CircuitAmount, Hex32, ShieldedAddress } from "../core/brand.js";
import type { FullViewingKey, SpendingKey, ViewingKey } from "../keys/keys.js";
import type { Prover } from "../prover/types.js";
import type { Scanner } from "../sync/scanner.js";
import type { AmountLike } from "./amount.js";
import type { AssetRef } from "./asset-ref.js";
import type { AssetInfo } from "./assets/index.js";
import type { FeeQuoteResult, QuoteFeeArgs } from "./fee-quote.js";
import type { AwaitCommitmentsOpts, AwaitCommitmentsResult } from "./note-cache.js";
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
import type {
    DepositResult,
    SwapResult,
    TransferResult,
    WalletNote,
    WithdrawResult,
} from "./result.js";
import type {
    CoinSelector,
    SelectionResult,
    SelectOpts,
    SpendableMax,
    WithheldValue,
} from "./selection/index.js";
import type { Submitter } from "./submitter.js";
import type { SyncOpts, SyncResult } from "./sync.js";
import type { DenominationChoice, WithdrawPreview } from "./withdraw-preview.js";

/**
 * What a wallet can answer from the notes it has scanned.
 *
 * Satisfied by `Wallet`, which adds the spend surface, and by `WatchWallet` in
 * `./watch/`, built from a viewing key. Depend on it for code that reports on
 * an account without spending from it.
 *
 * **Amounts are always in circuit units** — `tokenBaseUnits = amount *
 * asset.scale`. Use `wallet.asset(id)` plus `parseAmount` / `formatAmount`
 * from `./assets.js` to move between circuit units and what a user types.
 *
 * ```ts
 * const wallet = await connectWatch({ network: "anvil", viewingKey });
 * await wallet.sync();
 * wallet.balance(assetId(1n));
 * wallet.spentKnown;   // false ⇒ balance is gross received, not remaining
 * ```
 */
export interface ReadOnlyWalletApi {
    /** The shielded `lelantos1…` address this wallet watches (bech32m). */
    readonly address: ShieldedAddress;
    /**
     * The viewing capability this wallet holds. A {@link SpendingKey} satisfies
     * it; {@link WalletApi} narrows it to one.
     */
    readonly keys: ViewingKey | FullViewingKey;
    readonly noteStore: NoteStore;
    readonly noteSource: NoteSource;
    readonly scanner: Scanner;

    /**
     * Whether this wallet can distinguish a spent note from an unspent one.
     *
     * `false` for an incoming-viewing-key holder, which has no `nk` and cannot
     * recompute nullifiers. Every note then reads unspent, and `balance` is the
     * gross amount received.
     */
    readonly spentKnown: boolean;

    // --- sync ----------------------------------------------------------------

    /** Pull encrypted notes only. Sufficient for balance display; does not sync the Merkle tree. */
    syncNotes(opts?: SyncOpts): Promise<SyncResult>;
    /**
     * Pull notes and the spent set in parallel, plus the commitment feed on a
     * wallet that keeps a Merkle tree, then reconcile which local notes are
     * now spent.
     */
    sync(opts?: SyncOpts): Promise<SyncResult>;
    /**
     * Fetch new spent-nullifier chunks into the local set. Idempotent —
     * resumes from its own cursor. A stale mirror only ever under-reports
     * spends; it never marks a live note spent.
     */
    syncNullifiers(): Promise<void>;
    refresh(): Promise<void>;
    /**
     * Poll until every commitment in `cms` is in the local store.
     *
     * Resolves with a status rather than void, so "the indexer is behind" is
     * distinguishable from "all present".
     */
    awaitCommitments(cms: Hex32[], opts?: AwaitCommitmentsOpts): Promise<AwaitCommitmentsResult>;
    // --- read ----------------------------------------------------------------

    /** Omit a field to stop filtering on it; `notes()` returns everything. */
    notes(filter?: NotesFilter): WalletNote[];
    /** Unspent total for one asset, in circuit units. */
    balance(asset: AssetIdLike): CircuitAmount;
    /** Unspent totals keyed by asset id — one pass for a multi-asset view. */
    balances(): Map<AssetId, CircuitAmount>;
    /**
     * Registry entry for `id` plus ERC-20 symbol/decimals when the adapter
     * exposes them. Cached per wallet; pass `{ refresh: true }` to re-read.
     */
    asset(ref: AssetRef, opts?: { refresh?: boolean }): Promise<AssetInfo>;
    /** Every asset registered on this chain, lowest id first. */
    assets(): Promise<AssetInfo[]>;

    // --- maintenance ---------------------------------------------------------

    /**
     * Drop notes flagged `spent: true` from the underlying store. Returns
     * the number of notes pruned. Balance is unaffected; this only shrinks
     * the on-disk file. Live notes and reconcile state are preserved.
     */
    compact(): Promise<{ removed: number }>;
    /**
     * Release scanner workers and any prover worker this wallet built.
     *
     * A `WorkerPoolScanner` holds 2–8 workers, each with its own wasm heap, so
     * an app that rebuilds its wallet on an account or network switch must
     * call this or leak a pool per switch. Idempotent; the wallet must not be
     * used afterwards.
     */
    dispose(): Promise<void>;
    /**
     * Alias for {@link ReadOnlyWalletApi.dispose}, so a caller on a runtime
     * with `Symbol.asyncDispose` can write `await using wallet = await
     * connect(...)` and let scope exit release the workers.
     */
    [Symbol.asyncDispose](): Promise<void>;
}

/**
 * The high-level wallet surface. `Wallet` in `./wallet.ts` is the shipped
 * implementation; depend on this interface to keep tests mockable.
 *
 * Everything it adds over {@link ReadOnlyWalletApi} either builds a proof or
 * supplies the key material to authorise one.
 *
 * Typical lifecycle:
 *
 * ```ts
 * const wallet = await connect({ network: "anvil", privateKey, rpcUrl });
 * await wallet.sync();                              // notes + Merkle tree
 * const weth = requireTokenMeta(await wallet.asset(assetId(1n)));
 * await wallet.deposit({ asset: weth.id, amount: parseAmount("0.25", weth) });
 * await wallet.sync();
 * wallet.balance(weth.id);
 * ```
 */
export interface WalletApi extends ReadOnlyWalletApi {
    /** Spend authority. Narrows {@link ReadOnlyWalletApi.keys}. */
    readonly keys: SpendingKey;
    /** Cast to a concrete adapter type for adapter-specific accessors. */
    readonly chain: ChainReader;
    readonly submitter: Submitter;
    readonly prover: Prover;
    readonly selector: CoinSelector;

    /** Fetch new Merkle commitment chunks and rebuild the local tree. Required before spending. */
    syncTree(): Promise<void>;

    /**
     * What relaying `kind` costs and which assets can pay for it, checked
     * against this wallet's balances. Empty when the relayer charges nothing.
     */
    quoteFee(args: QuoteFeeArgs): Promise<FeeQuoteResult>;
    /**
     * The largest amount of `asset` a single spend can cover, and what is
     * holding the rest back.
     *
     * Not the balance. The selector withholds notes that are reserved by an
     * unconfirmed spend, still in their spend cooldown, or below the dust
     * threshold, and a spend can consume only `maxInputs` of what remains — so
     * a "max" built on the balance produces `InsufficientCoverError` against a
     * figure the caller itself supplied. `withheld` breaks the difference down
     * by cause so a UI can say which it is.
     *
     * Takes the same {@link SelectOpts} a spend does, so the prediction and the
     * spend cannot be computed under different rules. `maxInputs` defaults to
     * the circuit's `nIn`; pass `nIn - 1` when a cross-asset fee will need an
     * input slot of its own, and `fee` for one paid in this same asset.
     */
    spendableMax(asset: AssetId, opts?: SelectOpts): Promise<SpendableMax>;
    selectNotes(asset: AssetId, target: CircuitAmount, opts?: SelectOpts): SelectionResult;
    /**
     * What a withdrawal of `amount` would actually deliver, before running it.
     *
     * ```ts
     * const p = await wallet.previewWithdraw({ asset: "USDC", amount: "1000" });
     * p.netFormatted; // "998" — what actually arrives
     * p.onLadder;     // true
     * ```
     */
    previewWithdraw(args: {
        amount: AmountLike;
        asset?: AssetRef | undefined;
    }): Promise<WithdrawPreview>;
    /**
     * The asset's withdrawal denominations, labelled for a picker. Empty for
     * an asset with no ladder, where any amount is as good as any other.
     */
    withdrawDenominations(ref?: AssetRef): Promise<DenominationChoice[]>;

    // --- spend ---------------------------------------------------------------

    /** Shield ERC-20 (or native ETH via `asEth`) into the MASP. */
    deposit(args: DepositOptions): Promise<DepositResult>;
    /** Shielded transfer to another `lelantos1…` address. */
    transfer(args: TransferOptions): Promise<TransferResult>;
    /** Unshield to an ERC-20 recipient. */
    withdraw(args: WithdrawOptions): Promise<WithdrawResult>;
    /** Unshield to raw ETH via the WETH bridge. */
    withdrawEth(args: WithdrawEthOptions): Promise<WithdrawResult>;
    /** Atomic shielded swap; legs bundled via `submitter.submitSwap`. */
    swap(args: SwapOptions): Promise<SwapResult>;
    /**
     * Reclaim an escrowed deposit that the relayer never flushed.
     * Permissionless once `chain.cancelDelay()` blocks have passed. Supply
     * the `DepositEscrowed` event payload — the contract re-derives the
     * digest from it.
     */
    cancelDeposit(id: bigint, inputs: CancelDepositInputs): Promise<{ txHash: Hex32 }>;
    markSpent(noteIds: string[]): Promise<void>;
    /**
     * Re-split notes that sit off the asset's denomination ladder, so future
     * spends can be covered by on-ladder notes. Returns the number of rounds
     * run; zero means the asset has no ladder, or nothing was off it.
     *
     * Best-effort: a round that cannot find cover stops the loop rather than
     * throwing, because a partially-tidied note set is a strictly better
     * position than the one it started from.
     */
    redenominate(ref: AssetRef, opts?: { maxRounds?: number }): Promise<number>;
}

export type { AssetInfo, AssetInfoWithMeta } from "./assets/index.js";
// Re-exported for backwards compatibility with `./api.js` imports.
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
export type { CoinSelector, SelectionResult, SelectOpts, SpendableMax, WithheldValue };
