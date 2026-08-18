// High-level Wallet. Owns keys + `NoteCache`; every external dependency
// (ChainAdapter, NoteSource, Submitter, Prover, CoinSelector, NoteStore)
// is injected via `cfg`. Per-tx logic lives in `./{deposit,transfer,
// withdraw,swap}.ts`; cache + persistence in `./note-cache.ts`.

import { createMutex } from "../core/async.js";
import {
    type AssetId,
    type AssetIdLike,
    assetId,
    branded,
    type CircuitAmount,
    type Hex32,
    type ShieldedAddress,
} from "../core/brand.js";
import { DepositAdapterError } from "../core/errors.js";
import { buildNullifierFromNsk, type Field, type Jubjub, Poseidon } from "../crypto/index.js";
import { WasmJubjub } from "../crypto/jubjub-wasm/index.js";
import { type KeySource, resolveNsk } from "../keys/key-source.js";
import { addressFromSpendingKey, buildSpendingKey, type SpendingKey } from "../keys/keys.js";
import { getLogger } from "../log/logger.js";
import type { Prover } from "../prover/types.js";
import type { Scanner } from "../sync/scanner.js";
import type {
    DepositOptions,
    DepositResult,
    NotesFilter,
    SwapOptions,
    SwapResult,
    TransferOptions,
    TransferResult,
    WalletApi,
    WalletNote,
    WithdrawEthOptions,
    WithdrawOptions,
    WithdrawResult,
} from "./api.js";
import type { AssetInfo } from "./assets.js";
import { fetchAssetInfo } from "./assets.js";
import type { ResolvedWalletConfig, WalletConfig } from "./config.js";
import { DEFAULT_ASSET } from "./constants.js";
import type { SpendContext } from "./context.js";
import { resolveConfig, validateConfig } from "./defaults/index.js";
import { executeDeposit } from "./deposit.js";
import {
    type AwaitCommitmentsOpts,
    type AwaitCommitmentsResult,
    awaitCommitments,
    NoteCache,
} from "./note-cache.js";
import type { NoteSource } from "./note-source.js";
import {
    type NoteStore,
    type NotesFile,
    type StoredNote,
    withinReservation,
} from "./note-store.js";
import type { NullifierStore } from "./nullifier-store.js";
import { toWalletNote } from "./result-builder.js";
import type { CoinSelector, SelectionResult, SelectOpts } from "./selection.js";
import type { Submitter } from "./submitter.js";
import { executeSwap } from "./swap.js";
import { type SyncOpts, type SyncResult, syncWallet } from "./sync.js";
import { executeTransfer } from "./transfer.js";
import type { TreeStore } from "./tree-store.js";
import { executeWithdraw } from "./withdraw.js";

const log = getLogger("lelantos:wallet");

export class Wallet implements WalletApi, SpendContext {
    readonly P: Poseidon;
    readonly J: Jubjub;
    readonly keys: SpendingKey;
    readonly address: ShieldedAddress;
    readonly cfg: ResolvedWalletConfig;
    /** @internal — cache + persistence. Use `wallet.file` for read access. */
    readonly cache: NoteCache;
    private readonly assetCache = new Map<bigint, AssetInfo>();
    /**
     * Memoised note id → nullifier, so a reconcile pass costs one Poseidon per
     * *newly seen* note rather than one per unspent note per sync.
     *
     * In memory only, deliberately. `StoredNote` is the persisted schema, and
     * the notes file carries no `nsk` — so a leaked or backed-up file today
     * links its holder to the user's on-chain commitments but not to their
     * spends. Nullifiers are exactly the on-chain spend identifiers; writing
     * them into the file would hand over that second half. Keyed by `id`
     * rather than the note object because `cache.refresh()` may rehydrate new
     * objects, while ids are persisted and stable.
     */
    private readonly nullifierCache = new Map<string, Field>();
    /** Set by {@link Wallet.dispose}, so a second call is a no-op. */
    private disposed = false;
    /** Serialises `sync` / `syncNotes`. See {@link Wallet.syncExclusive}. */
    private readonly syncs = createMutex();

    /** @internal — exposed for per-tx helper modules. */
    get file(): NotesFile {
        return this.cache.file;
    }

    get noteStore(): NoteStore {
        return this.cache.store;
    }
    // No casts: `ResolvedWalletConfig` marks these required, so the compiler
    // checks that `create()` wired them.
    get noteSource(): NoteSource {
        return this.cfg.noteSource;
    }
    get treeStore(): TreeStore {
        return this.cfg.treeStore;
    }
    get nullifierStore(): NullifierStore {
        return this.cfg.nullifierStore;
    }
    get submitter(): Submitter {
        return this.cfg.submitter;
    }
    get prover(): Prover {
        return this.cfg.prover;
    }
    get selector(): CoinSelector {
        return this.cfg.selector;
    }
    get scanner(): Scanner {
        return this.cfg.scanner;
    }
    get chain(): WalletConfig["chain"] {
        return this.cfg.chain;
    }

    /** {@link SpendContext} — the raw stored-note list. */
    storedNotes(): readonly StoredNote[] {
        return this.cache.file.notes;
    }

    /** {@link SpendContext} — config override, else the chain's fee. */
    async feeBps(): Promise<bigint> {
        return this.cfg.feeBps ?? (await this.cfg.chain.fetchFeeBps());
    }

    private constructor(args: {
        P: Poseidon;
        J: Jubjub;
        keys: SpendingKey;
        address: ShieldedAddress;
        cfg: ResolvedWalletConfig;
        cache: NoteCache;
    }) {
        this.P = args.P;
        this.J = args.J;
        this.keys = args.keys;
        this.address = args.address;
        this.cfg = args.cfg;
        this.cache = args.cache;
    }

    // Convenience constructors live on `connect()`; import it directly. A
    // static forwarder here would need `await import("./connect.js")` to break
    // the wallet -> connect -> index -> wallet cycle.

    /**
     * Build from any key source. Wires defaults for omitted pluggables.
     * Collects every config problem into `WalletConfigError.missing`.
     */
    static async create(source: KeySource, cfg: WalletConfig): Promise<Wallet> {
        validateConfig(cfg);

        const P = await Poseidon.build();
        const J = await WasmJubjub.build();
        const nsk = resolveNsk(source);
        const keys = buildSpendingKey(P, J, nsk);
        const address = addressFromSpendingKey(J, keys);

        const resolved = await resolveConfig(cfg, { P, J });
        const cache = await NoteCache.open(resolved.noteStore);

        return new Wallet({ P, J, keys, address, cfg: resolved, cache });
    }

    private async _syncNotes(opts?: SyncOpts): Promise<SyncResult> {
        return syncWallet(
            {
                J: this.J,
                ivk: this.keys.ivk,
                source: this.noteSource,
                sink: this.cache,
                scanner: this.scanner,
            },
            opts ?? {},
        );
    }

    /**
     * Run `op` after any sync already in progress.
     *
     * A sync is `load` → scan → `save` over shared state, so two overlapping
     * ones — a poll timer and a user-initiated `sync()`, or `awaitCommitments`
     * polling while the app refreshes — interleave, and the later save wins.
     * `NoteCache` serialises its own writes, but not the scan between them.
     *
     * Serialising rather than rejecting: a caller that asked to sync should
     * get a sync, and the second one is cheap because the first has already
     * advanced the cursor.
     */
    private syncExclusive<T>(op: () => Promise<T>): Promise<T> {
        return this.syncs.run(op);
    }

    /**
     * Pull encrypted notes, trial-decrypt with `ivk + dk`, persist hits.
     *
     * Pages the feed to exhaustion, resuming from the cursor on
     * `NotesFile.cursor`, so a caught-up wallet fetches nothing. Idempotent:
     * re-scanning a note already stored is dropped by `cm`. Does not sync the
     * tree. `limit` is the page size, not a ceiling on notes fetched.
     */
    async syncNotes(opts?: SyncOpts): Promise<SyncResult> {
        return this.syncExclusive(() => this._syncNotesAndReconcile(opts));
    }

    private async _syncNotesAndReconcile(opts?: SyncOpts): Promise<SyncResult> {
        const result = await this._syncNotes(opts);
        await this.syncNullifiers();
        // No `refresh()`: `syncWallet` writes through `this.cache`, so the
        // snapshot reconciliation is about to read already holds the new
        // notes. Reloading here would have re-read the store instead — and
        // reconciliation would then persist whichever copy it happened to
        // hold, erasing the other's writes.
        await this.reconcileSpentOnChain();
        return result;
    }

    /**
     * Fetch new Merkle commitment chunks and rebuild the local tree.
     * Idempotent — resumes from `syncedCount` cursor. Does not scan notes.
     */
    async syncTree(): Promise<void> {
        await this.treeStore.sync();
    }

    /**
     * Fetch new spent-nullifier chunks into the local set. Idempotent —
     * resumes from its own cursor. `reconcileSpentOnChain` reads this set, so
     * a stale mirror only ever under-reports spends; it never marks a live
     * note spent.
     */
    async syncNullifiers(): Promise<void> {
        await this.nullifierStore.sync();
    }

    /**
     * Pull encrypted notes, the Merkle tree, and the spent set in parallel,
     * then reconcile which local notes are now spent. Convenience wrapper
     * around `syncNotes` + `syncTree` + `syncNullifiers`.
     */
    async sync(opts?: SyncOpts): Promise<SyncResult> {
        return this.syncExclusive(() => this._syncAll(opts));
    }

    private async _syncAll(opts?: SyncOpts): Promise<SyncResult> {
        const signal = opts?.signal;
        const [result] = await Promise.all([
            this._syncNotes(opts),
            this.treeStore.sync(signal ? { signal } : {}),
            this.nullifierStore.sync(signal ? { signal } : {}),
        ]);
        // See `syncNotes` for why there is no `refresh()` here.
        await this.reconcileSpentOnChain();
        return result;
    }

    /**
     * Mark locally-unspent notes whose nullifiers are already consumed on
     * chain, against the locally mirrored spent set. Purely local: querying
     * the server per nullifier would name the caller's own notes.
     * @internal
     */
    async reconcileSpentOnChain(): Promise<void> {
        const candidates = this.cache.notes.filter((n) => !n.spent);
        const spentIds = new Set(
            candidates.filter((n) => this.nullifierStore.has(this.nullifierOf(n))).map((n) => n.id),
        );

        // Retire memo entries the next pass will never ask for again: the
        // notes just found spent, plus anything `markSpent` or `compact`
        // retired since the last pass. Only unspent notes are ever looked up.
        const keep = new Set(candidates.map((n) => n.id));
        for (const id of this.nullifierCache.keys()) {
            if (!keep.has(id) || spentIds.has(id)) this.nullifierCache.delete(id);
        }

        // A reservation stands in for exactly the answer this pass just
        // fetched, so it is released either way: a note found spent no longer
        // needs one, and one that outlived `SPEND_RESERVATION_MS` without its
        // nullifier appearing describes a spend that never landed — releasing
        // it returns the balance without a rescan.
        const now = Date.now();
        await this.cache.reconcile({
            spent: (n) => spentIds.has(n.id),
            release: (n) => spentIds.has(n.id) || !withinReservation(n.pendingSpendAt, now),
        });
    }

    /** This note's nullifier, deriving it only the first time it is asked for. */
    private nullifierOf(n: StoredNote): Field {
        let nf = this.nullifierCache.get(n.id);
        if (nf === undefined) {
            nf = buildNullifierFromNsk(this.P, this.keys.nsk, BigInt(n.rho), BigInt(n.cm));
            this.nullifierCache.set(n.id, nf);
        }
        return nf;
    }

    /** Reload in-memory cache from `NoteStore` after external mutation. */
    async refresh(): Promise<void> {
        await this.cache.refresh();
    }

    async compact(): Promise<{ removed: number }> {
        return this.cache.compact();
    }

    /**
     * Poll `sync()` until every commitment in `cms` is stored locally.
     *
     * Reports whether they arrived — see {@link AwaitCommitmentsResult}. Does
     * not throw on timeout by default: this runs after a successful broadcast,
     * so a lagging indexer is not a failed transaction.
     */
    awaitCommitments(
        cms: string[],
        opts: AwaitCommitmentsOpts = {},
    ): Promise<AwaitCommitmentsResult> {
        return awaitCommitments(
            cms,
            () => this.cache.notes,
            (limit) => this.sync({ limit }),
            opts,
        );
    }

    notes(filter: NotesFilter = {}): WalletNote[] {
        return this.cache.notes
            .filter((n) => {
                if (filter.spent !== undefined && n.spent !== filter.spent) return false;
                if (filter.asset !== undefined && BigInt(n.asset) !== filter.asset) return false;
                return true;
            })
            .map(toWalletNote);
    }

    /**
     * @deprecated Use `notes()` — it now takes an optional filter and reads
     * across every asset when `asset` is omitted.
     */
    allNotes(filter: { spent?: boolean } = {}): WalletNote[] {
        return this.notes(filter);
    }

    balance(asset: AssetIdLike): CircuitAmount {
        return branded<CircuitAmount>(
            this.cache.notes
                .filter((n) => !n.spent && BigInt(n.asset) === asset)
                .reduce((s, n) => s + BigInt(n.value), 0n),
        );
    }

    balances(): Map<AssetId, CircuitAmount> {
        const out = new Map<AssetId, CircuitAmount>();
        for (const n of this.cache.notes) {
            if (n.spent) continue;
            const asset = branded<AssetId>(BigInt(n.asset));
            out.set(asset, branded<CircuitAmount>((out.get(asset) ?? 0n) + BigInt(n.value)));
        }
        return out;
    }

    /**
     * Registry entry for `id` plus ERC-20 symbol/decimals when the adapter
     * exposes them. Cached for the wallet's lifetime — asset entries are
     * immutable apart from the `disabled` flag; `{ refresh: true }` re-reads
     * it.
     */
    async asset(id: AssetIdLike, opts: { refresh?: boolean } = {}): Promise<AssetInfo> {
        const key = assetId(id);
        const hit = this.assetCache.get(key);
        if (hit && !opts.refresh) return hit;
        const info = await fetchAssetInfo(this.cfg.chain, key);
        this.assetCache.set(key, info);
        return info;
    }

    selectNotes(asset: AssetId, target: CircuitAmount, opts?: SelectOpts): SelectionResult {
        return this.selector.select(this.cache.notes, asset, target, opts);
    }

    /**
     * Shield ERC-20 into the MASP via Permit2 escrow. Funds sit in
     * escrow until the relayer flushes a batch (or `cancelDeposit` after
     * `cancelDelay` blocks). For native ETH set `asEth: true`.
     */
    async deposit(args: DepositOptions): Promise<DepositResult> {
        return executeDeposit(this, args);
    }

    /**
     * Cancel an escrowed deposit. Permissionless after `cancelDelay`
     * blocks. Caller supplies the `DepositEscrowed` event payload for the
     * on-chain digest check.
     */
    async cancelDeposit(
        id: bigint,
        inputs: import("../chain/types.js").CancelDepositInputs,
    ): Promise<{ txHash: Hex32 }> {
        if (!this.cfg.chain.cancelDeposit) {
            throw new DepositAdapterError("witness", ["cancelDeposit"]);
        }
        return this.cfg.chain.cancelDeposit(id, inputs);
    }

    /**
     * Shielded transfer: 1-2 notes → send-note + change-note → submit →
     * mark spent. Throws `InsufficientCoverError` on no 1/2-note cover.
     */
    async transfer(args: TransferOptions): Promise<TransferResult> {
        return executeTransfer(this, args);
    }

    /** Unshield ERC20 to `args.to`. Throws `InsufficientCoverError` on no cover. */
    async withdraw(args: WithdrawOptions): Promise<WithdrawResult> {
        return executeWithdraw(this, { ...args, asset: args.asset ?? DEFAULT_ASSET }, "withdraw");
    }

    /** Unshield to raw ETH via `NativeAdapter.withdrawNative`, which unwraps. */
    async withdrawEth(args: WithdrawEthOptions): Promise<WithdrawResult> {
        return executeWithdraw(
            this,
            {
                to: args.to,
                amount: args.amount,
                asset: args.asset,
                selectOpts: args.selectOpts,
                autoConsolidate: args.autoConsolidate,
                onPhase: args.onPhase,
            },
            "withdrawNative",
        );
    }

    /**
     * Atomic shielded swap. Leg-1 transact_2x2 unshields to SwapWrapper;
     * leg-2 deposit request re-shields the B note. Bundled via
     * `submitter.submitSwap`. `args.amount` is gross publicOut in circuit
     * units of `assetIn`; MASP skims `feeBps` before transferring.
     */
    async swap(args: SwapOptions): Promise<SwapResult> {
        return executeSwap(this, args);
    }

    /**
     * Called automatically by `transfer` / `withdraw`; exposed for
     * alternative spend flows.
     */
    async markSpent(noteIds: string[]): Promise<void> {
        await this.cache.markSpent(noteIds);
    }

    /**
     * Reserve notes against a spend whose outcome is unknown, so the selector
     * stops offering them until reconciliation or expiry settles it.
     *
     * Called automatically when a submit fails without an answer; see
     * `submitSpend` and `StoredNote.pendingSpendAt`.
     */
    async markPendingSpend(noteIds: string[]): Promise<void> {
        await this.cache.markPendingSpend(noteIds);
    }

    /**
     * Release everything this wallet holds: scanner workers and, if one was
     * built, the prover's.
     *
     * `WorkerPoolScanner` spawns 2–8 workers per wallet, each with its own
     * wasm heap, and `Scanner.dispose` existed with no caller — so an app that
     * rebuilds its wallet on an account or network switch leaked a whole pool
     * every time.
     *
     * Idempotent, and safe on a wallet that never synced or proved. The wallet
     * must not be used afterwards.
     */
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        // Settled, not raced: one backend failing to shut down must not leave
        // the other running.
        const outcomes = await Promise.allSettled([
            this.cfg.scanner.dispose?.(),
            this.cfg.prover?.dispose?.(),
        ]);
        for (const o of outcomes) {
            if (o.status === "rejected") log.warn("dispose failed", { err: o.reason });
        }
    }

    /**
     * Self-spend the two smallest notes for `asset` into one change note.
     * Sends `consolidateSum - 1n` so a 1-unit change note pops out (some
     * selectors discard zero-value change).
     * @internal — used by per-tx helper modules for the auto-consolidate fallback.
     */
    async autoConsolidate(
        asset: AssetId,
        selection: Extract<SelectionResult, { plan: "consolidate-first" }>,
    ): Promise<void> {
        const target = branded<CircuitAmount>(
            selection.consolidateSum > 1n
                ? selection.consolidateSum - 1n
                : selection.consolidateSum,
        );
        await this.transfer({
            to: this.address,
            amount: target,
            asset,
            // Inner call must NOT recurse.
            autoConsolidate: false,
        });
        await this.sync();
    }
}
