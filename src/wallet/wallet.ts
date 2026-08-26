// High-level Wallet. Owns keys + `NoteCache`; every external dependency
// (ChainAdapter, NoteSource, Submitter, Prover, CoinSelector, NoteStore)
// is injected via `cfg`. Per-tx logic lives in `./{deposit,transfer,
// withdraw,swap}.ts`; cache + persistence in `./note-cache.ts`.

import { createMutex, sleep } from "../core/async.js";
import {
    type AssetId,
    type AssetIdLike,
    branded,
    type CircuitAmount,
    type Hex32,
    type ShieldedAddress,
} from "../core/brand.js";
import { DepositAdapterError } from "../core/errors.js";
import { type Jubjub, Poseidon } from "../crypto/index.js";
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
import type { AssetRef } from "./asset-ref.js";
import { AssetRegistry } from "./asset-registry.js";
import type { AssetInfo } from "./assets.js";
import { fetchAssetInfo } from "./assets.js";
import type { ResolvedWalletConfig, WalletConfig } from "./config.js";
import { DEFAULT_ASSET } from "./constants.js";
import type { SpendContext } from "./context.js";
import { resolveConfig, validateConfig } from "./defaults/index.js";
import { executeDeposit } from "./deposit.js";
import { type FeeQuoteResult, type QuoteFeeArgs, quoteFee } from "./fee-quote.js";
import {
    type AwaitCommitmentsOpts,
    type AwaitCommitmentsResult,
    awaitCommitments,
    NoteCache,
} from "./note-cache.js";
import type { NoteSource } from "./note-source.js";
import type { NoteStore, NotesFile, StoredNote } from "./note-store.js";
import type { NullifierStore } from "./nullifier-store.js";
import { toWalletNote } from "./result-builder.js";
import {
    type CoinSelector,
    DEFAULT_COOLDOWN_BLOCKS,
    type SelectionResult,
    type SelectOpts,
    type SpendableMax,
    spendableMax,
} from "./selection.js";
import type { Submitter } from "./submitter.js";
import { executeSwap } from "./swap.js";
import type { SyncOpts, SyncResult } from "./sync.js";
import {
    NullifierMemo,
    reconcileSpentOnChain,
    type SyncContext,
    syncAll,
    syncNotesAndReconcile,
} from "./sync-ops.js";
import { executeTransfer } from "./transfer.js";
import type { TreeStore } from "./tree-store.js";
import { executeWithdraw } from "./withdraw.js";

const log = getLogger("lelantos:wallet");

/**
 * How long to wait for a consolidated note to clear its spend cooldown.
 *
 * The merged note is unspendable until it is `cooldownBlocks` old, so the
 * caller's retry is pointless before then. A chain that is not producing
 * blocks hits this and logs.
 */
const COOLDOWN_WAIT_MS = 30_000;
/**
 * Poll interval while waiting.
 *
 * Coarser than it looks: `ViemChainAdapter.blockNumber()` is cached for
 * `cacheTime` (4s by default), so most polls resolve from that cache rather
 * than the network.
 */
const COOLDOWN_POLL_MS = 1_000;

export class Wallet implements WalletApi, SpendContext, SyncContext {
    readonly P: Poseidon;
    readonly J: Jubjub;
    readonly keys: SpendingKey;
    readonly address: ShieldedAddress;
    readonly cfg: ResolvedWalletConfig;
    /** @internal — cache + persistence. Use `wallet.file` for read access. */
    readonly cache: NoteCache;
    /**
     * Asset lookup by id, token address or symbol.
     *
     * Lazily built: the token list costs a `/chains` call, which a wallet that
     * only ever names assets by id never has to make.
     */
    private assetRegistry: AssetRegistry | undefined;
    /** @internal — read by `./sync-ops.ts` through `SyncContext`. */
    readonly nullifiers: NullifierMemo;
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

    /** {@link SpendContext} — id, token address or symbol to a registry entry. */
    resolveAsset(ref: AssetRef): Promise<AssetInfo> {
        return this.assets_().resolve(ref);
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
        this.nullifiers = new NullifierMemo(args.P, args.keys.nsk);
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
     *
     * The mutex stays here rather than in `./sync-ops.ts` because it guards
     * *this wallet's* state; the operations themselves are stateless.
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
        return this.syncExclusive(() => syncNotesAndReconcile(this, opts));
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
        return this.syncExclusive(() => syncAll(this, opts));
    }

    /**
     * Mark locally-unspent notes whose nullifiers are already consumed on
     * chain, against the locally mirrored spent set.
     * @internal
     */
    async reconcileSpentOnChain(): Promise<void> {
        await reconcileSpentOnChain(this);
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

    async spendableMax(asset: AssetId, opts: SelectOpts = {}): Promise<SpendableMax> {
        // The same note set the selector reads — the in-memory cache, not the
        // persisted store. A caller reading `noteStore.load()` instead can see
        // a different set and compute a max the selector then refuses.
        //
        // Full `SelectOpts`, not a narrowed pair: a caller passing
        // `dustThreshold` or `cooldownBlocks` to `transfer` must be able to pass
        // the same here, or the prediction runs under different rules than the
        // spend it predicts.
        const tipBlock = await this.cfg.chain.blockNumber?.();
        return spendableMax(this.storedNotes(), asset, {
            maxInputs: this.cfg.shape.nIn,
            ...(tipBlock !== undefined ? { tipBlock } : {}),
            ...opts,
        });
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
    async asset(ref: AssetRef, opts: { refresh?: boolean } = {}): Promise<AssetInfo> {
        if (opts.refresh) {
            // A refresh is only meaningful against the chain registry, which
            // is the authority on `scale` and `disabled`.
            const { id } = await this.assets_().resolve(ref);
            const info = await fetchAssetInfo(this.cfg.chain, id);
            this.assets_().put(info);
            return info;
        }
        return this.assets_().resolve(ref);
    }

    /** Every asset this chain has registered, lowest id first. */
    assets(): Promise<AssetInfo[]> {
        return this.assets_().list();
    }

    /**
     * What relaying `kind` costs and what it may be paid in, before building
     * anything.
     *
     * `options[].affordable` is checked against this wallet's own balances, so
     * a UI can offer only the assets the holder can actually pay with.
     */
    quoteFee(args: QuoteFeeArgs): Promise<FeeQuoteResult> {
        return quoteFee(this, args);
    }

    private assets_(): AssetRegistry {
        this.assetRegistry ??= new AssetRegistry({
            chain: this.cfg.chain,
            ...(this.cfg.submitter.assets
                ? { tokens: () => this.cfg.submitter.assets!(this.cfg.chainId) }
                : {}),
        });
        return this.assetRegistry;
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
     * Self-spend the notes `selection` named into one change note.
     *
     * Sends `consolidateSum - 1n` so a 1-unit change note pops out (some
     * selectors discard zero-value change).
     *
     * Three details are what make this actually merge, rather than appear to:
     *
     *   * **The notes are pinned.** Passing only an amount let the inner
     *     selector cover it however it liked — usually with one large note,
     *     merging none of the dust this was called to merge. `only` restricts
     *     it to exactly the ids the caller named.
     *   * **The change note is waited for.** `sync()` alone returns as soon as
     *     one scan pass completes, which is typically before the relayer's tx
     *     is mined, so the retry re-selected against a store that did not yet
     *     contain the merged note.
     *   * **Its cooldown is waited out.** A note is unspendable until
     *     `tip - firstSeenBlock >= cooldownBlocks`, so a merge is useless to
     *     the caller until a block has passed. Waiting here — rather than
     *     lowering the cooldown for the retry — keeps the property the
     *     cooldown exists for: spending a change note in the block that
     *     created it links the two for anyone counting leaves.
     *
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
        const result = await this.transfer({
            to: this.address,
            amount: target,
            asset,
            selectOpts: {
                only: selection.consolidate.map((n) => n.id),
                // Merging, so use every slot the circuit provides.
                maxInputs: this.cfg.shape.nIn,
            },
            // Inner call must NOT recurse.
            autoConsolidate: false,
        });
        await this.awaitCommitments([...result.ownCommitments]);
        await this.awaitCooldown(asset, result.ownCommitments);
    }

    /**
     * Block until the merged note has aged past the selector's spend cooldown.
     *
     * Measured against the note's own `firstSeenBlock`, not against a tip
     * captured on entry: `awaitCommitments` has already returned by this point,
     * so the note is in the cache with its block recorded, and indexing lag
     * often means the tip is *already* far enough ahead. Waiting on "the tip
     * moves once" instead would burn a block time the common case does not owe.
     *
     * Returns immediately when the adapter cannot report a block number, or
     * when the note carries no `firstSeenBlock` — the selector's cooldown is
     * inert in both cases, so there is nothing to wait for.
     */
    private async awaitCooldown(asset: AssetId, cms: readonly string[]): Promise<void> {
        const cooldown = DEFAULT_COOLDOWN_BLOCKS;
        const wanted = new Set(cms.map((c) => c.toLowerCase()));
        const bornAt = this.cache.notes
            .filter((n) => wanted.has(n.cm.toLowerCase()))
            .map((n) => n.firstSeenBlock)
            .filter((b): b is number => b !== undefined);
        if (bornAt.length === 0) return;
        const spendableAt = Math.max(...bornAt) + cooldown;

        for (let waited = 0; ; waited += COOLDOWN_POLL_MS) {
            const tip = await this.cfg.chain.blockNumber?.();
            if (tip === undefined || tip >= spendableAt) return;
            if (waited >= COOLDOWN_WAIT_MS) break;
            await sleep(COOLDOWN_POLL_MS);
        }
        // Not fatal: the caller's next selection simply may not see the note,
        // and it will report insufficient cover rather than doing something
        // wrong. Worth a line, because on a chain that is not producing blocks
        // this is the reason consolidation looks like it did nothing.
        log.warn("chain tip did not advance; a consolidated note may still be in cooldown", {
            asset: asset.toString(),
            waitedMs: COOLDOWN_WAIT_MS,
        });
    }
}
