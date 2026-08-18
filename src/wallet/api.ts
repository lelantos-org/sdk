// Public Wallet API interface. Options live in `./options.ts`, results in
// `./result.ts`. `Wallet` in `./wallet.ts` is the default impl.

import type { ChainAdapter } from "../chain/port.js";
import type { CancelDepositInputs } from "../chain/types.js";
import type { AssetId, AssetIdLike, CircuitAmount, Hex32, ShieldedAddress } from "../core/brand.js";
import type { SpendingKey } from "../keys/keys.js";
import type { Prover } from "../prover/types.js";
import type { Scanner } from "../sync/scanner.js";
import type { AssetInfo } from "./assets.js";
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
import type { CoinSelector, SelectionResult, SelectOpts } from "./selection.js";
import type { Submitter } from "./submitter.js";
import type { SyncOpts, SyncResult } from "./sync.js";

/**
 * The high-level wallet surface. `Wallet` in `./wallet.ts` is the shipped
 * implementation; depend on this interface to keep tests mockable.
 *
 * **Amounts are always in circuit units** — `tokenBaseUnits = amount *
 * asset.scale`. Use `wallet.asset(id)` plus `parseAmount` / `formatAmount`
 * from `./assets.js` to move between circuit units and what a user types.
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
export interface WalletApi {
    /** This wallet's shielded `lelantos1…` address (bech32m). */
    readonly address: ShieldedAddress;
    readonly keys: SpendingKey;
    readonly noteStore: NoteStore;
    /** Cast to a concrete adapter type for adapter-specific accessors. */
    readonly chain: ChainAdapter;
    readonly noteSource: NoteSource;
    readonly submitter: Submitter;
    readonly prover: Prover;
    readonly scanner: Scanner;
    readonly selector: CoinSelector;

    // --- sync ----------------------------------------------------------------

    /** Pull encrypted notes only. Sufficient for balance display; does not sync the Merkle tree. */
    syncNotes(opts?: SyncOpts): Promise<SyncResult>;
    /** Fetch new Merkle commitment chunks and rebuild the local tree. Required before spending. */
    syncTree(): Promise<void>;
    /**
     * Pull notes and sync the tree in parallel. Convenience wrapper around `syncNotes` + `syncTree`.
     */
    sync(opts?: SyncOpts): Promise<SyncResult>;
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
    /**
     * @deprecated Use `notes()` — it now takes an optional filter and reads
     * across every asset when `asset` is omitted.
     */
    allNotes(filter?: { spent?: boolean }): WalletNote[];
    /** Unspent total for one asset, in circuit units. */
    balance(asset: AssetIdLike): CircuitAmount;
    /** Unspent totals keyed by asset id — one pass for a multi-asset view. */
    balances(): Map<AssetId, CircuitAmount>;
    /**
     * Registry entry for `id` plus ERC-20 symbol/decimals when the adapter
     * exposes them. Cached per wallet; pass `{ refresh: true }` to re-read.
     */
    asset(id: AssetIdLike, opts?: { refresh?: boolean }): Promise<AssetInfo>;
    selectNotes(asset: AssetId, target: CircuitAmount, opts?: SelectOpts): SelectionResult;

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
}

export type { AssetInfo, AssetInfoWithMeta } from "./assets.js";
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
export type { CoinSelector, SelectionResult, SelectOpts };
