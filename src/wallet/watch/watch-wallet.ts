// Watch-only wallet: the read surface of `Wallet`, built from a viewing key.
//
// Scanning requires only `ivk` (`../sync.ts`, `../../sync/scan.ts`), so this
// runs the same `NoteCache` without a prover, submitter, coin selector or
// Merkle tree.
//
// Must not import `../wallet.js`, which reaches the per-tx modules and the
// prover. Enforced by `scripts/check-layers.mjs`.

import type { ChainAdapter } from "../../chain/port.js";
import { createMutex } from "../../core/async.js";
import type {
    AssetId,
    AssetIdLike,
    CircuitAmount,
    ShieldedAddress,
    ViewingKeyString,
} from "../../core/brand.js";
import { WalletConfigError } from "../../core/errors.js";
import { type Jubjub, Poseidon } from "../../crypto/index.js";
import { WasmJubjub } from "../../crypto/jubjub-wasm/index.js";
import { addressFromViewingKey, type FullViewingKey, type ViewingKey } from "../../keys/keys.js";
import { decodeViewingKey, isFullViewingKey } from "../../keys/viewing-key.js";
import { getLogger } from "../../log/logger.js";
import type { Scanner } from "../../sync/scanner.js";
import type { ReadOnlyWalletApi } from "../api.js";
import type { AssetRef } from "../asset-ref.js";
import { AssetRegistry } from "../asset-registry.js";
import type { AssetInfo } from "../assets/index.js";
import {
    type AwaitCommitmentsOpts,
    type AwaitCommitmentsResult,
    awaitCommitments,
    NoteCache,
} from "../note-cache.js";
import type { NoteSource } from "../note-source.js";
import type { NoteStore } from "../note-store.js";
import type { NullifierStore } from "../nullifier-store.js";
import type { NotesFilter } from "../options.js";
import { balanceOf, balancesOf, filterNotes } from "../read-ops.js";
import type { WalletNote } from "../result.js";
import type { SyncOpts, SyncResult } from "../sync.js";
import { NullifierMemo, type SyncContext, syncNotesAndReconcile } from "../sync-ops.js";
import {
    type ResolvedWatchConfig,
    resolveWatchConfig,
    validateWatchConfig,
    type WatchWalletConfig,
} from "./config.js";

const log = getLogger("lelantos:watch");

export class WatchWallet implements ReadOnlyWalletApi, SyncContext {
    readonly P: Poseidon;
    readonly J: Jubjub;
    readonly keys: ViewingKey | FullViewingKey;
    readonly address: ShieldedAddress;
    readonly cfg: ResolvedWatchConfig;
    /** @internal — cache + persistence. Use `wallet.file` for read access. */
    readonly cache: NoteCache;
    /**
     * @internal — read by `../sync-ops.ts` through `SyncContext`. Absent for an
     * incoming viewing key, which has no `nk`.
     */
    readonly nullifiers: NullifierMemo | undefined;
    private assetRegistry: AssetRegistry | undefined;
    private disposed = false;
    private readonly syncs = createMutex();

    get noteStore(): NoteStore {
        return this.cache.store;
    }
    get noteSource(): NoteSource {
        return this.cfg.noteSource;
    }
    get nullifierStore(): NullifierStore {
        return this.cfg.nullifierStore;
    }
    get scanner(): Scanner {
        return this.cfg.scanner;
    }

    private constructor(args: {
        P: Poseidon;
        J: Jubjub;
        keys: ViewingKey | FullViewingKey;
        address: ShieldedAddress;
        cfg: ResolvedWatchConfig;
        cache: NoteCache;
    }) {
        this.P = args.P;
        this.J = args.J;
        this.keys = args.keys;
        this.address = args.address;
        this.cfg = args.cfg;
        this.cache = args.cache;
        this.nullifiers = isFullViewingKey(args.keys)
            ? new NullifierMemo(args.P, args.keys.nk)
            : undefined;
    }

    /**
     * Whether this wallet can settle spends, i.e. whether it was built from a
     * full viewing key.
     */
    get spentKnown(): boolean {
        return this.nullifiers !== undefined;
    }

    /**
     * Build from either viewing-key tier, or from its bech32m encoding.
     *
     * The tier is read from the key and reported by
     * {@link WatchWallet.spentKnown}.
     */
    static async create(
        key: ViewingKey | FullViewingKey | ViewingKeyString | string,
        cfg: WatchWalletConfig,
    ): Promise<WatchWallet> {
        validateWatchConfig(cfg);

        const P = await Poseidon.build();
        const J = await WasmJubjub.build();
        const keys = typeof key === "string" ? decodeViewingKey(P, J, key) : key;
        const address = addressFromViewingKey(P, J, keys);

        const resolved = await resolveWatchConfig(cfg, { P, J });
        const cache = await NoteCache.open(resolved.noteStore);

        return new WatchWallet({ P, J, keys, address, cfg: resolved, cache });
    }

    /** Serialises syncs: each is load → scan → save over shared state. */
    private syncExclusive<T>(op: () => Promise<T>): Promise<T> {
        return this.syncs.run(op);
    }

    /**
     * Pull encrypted notes, trial-decrypt with `ivk`, persist hits.
     *
     * Pages the feed to exhaustion from the cursor on `NotesFile.cursor`.
     */
    async syncNotes(opts?: SyncOpts): Promise<SyncResult> {
        return this.syncExclusive(() => syncNotesAndReconcile(this, opts));
    }

    async syncNullifiers(): Promise<void> {
        await this.nullifierStore.sync();
    }

    /**
     * Notes and the spent set, then reconcile. Syncs no Merkle tree, which is
     * read only to witness a spend.
     */
    async sync(opts?: SyncOpts): Promise<SyncResult> {
        return this.syncNotes(opts);
    }

    /** Reload in-memory cache from `NoteStore` after external mutation. */
    async refresh(): Promise<void> {
        await this.cache.refresh();
    }

    async compact(): Promise<{ removed: number }> {
        return this.cache.compact();
    }

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
        return filterNotes(this.cache.notes, filter);
    }

    balance(asset: AssetIdLike): CircuitAmount {
        return balanceOf(this.cache.notes, asset);
    }

    balances(): Map<AssetId, CircuitAmount> {
        return balancesOf(this.cache.notes);
    }

    async asset(ref: AssetRef, opts: { refresh?: boolean } = {}): Promise<AssetInfo> {
        const registry = this.assets_();
        return opts.refresh ? registry.refresh(ref) : registry.resolve(ref);
    }

    assets(): Promise<AssetInfo[]> {
        return this.assets_().list();
    }

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        try {
            await this.cfg.scanner.dispose?.();
        } catch (err) {
            log.warn("dispose failed", { err });
        }
    }

    /** `await using wallet = await connectWatch(...)`. Alias for {@link WatchWallet.dispose}. */
    [Symbol.asyncDispose](): Promise<void> {
        return this.dispose();
    }

    private assets_(): AssetRegistry {
        this.assetRegistry ??= new AssetRegistry({
            chain: this.requireChain(),
            denominations: this.cfg.denominations ?? true,
            ...(this.cfg.feeBps !== undefined ? { feeBps: this.cfg.feeBps } : {}),
        });
        return this.assetRegistry;
    }

    // Asset metadata is the only read that leaves the note cache, so the
    // adapter is optional and its absence is reported as a config error.
    private requireChain(): ChainAdapter {
        const chain = this.cfg.chain;
        if (!chain) {
            throw new WalletConfigError(
                "`chain` (ChainAdapter) — required for asset metadata, omitted on this watch wallet",
            );
        }
        return chain;
    }
}
