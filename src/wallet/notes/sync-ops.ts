// Sync orchestration: what to pull, in what order, and what to reconcile afterwards.
//
// `sync/notes-sync.ts` is the note-scanning engine (paging, trial decryption, cursor). This layer
// combines that scan with the tree and nullifier mirrors, marks local notes the chain considers
// spent, and serialises it all under the wallet's sync lock.
//
// Depends on `SyncContext`, the read half of `WalletContext`, so a watch wallet runs the same code
// and a test can supply an object literal without wasm, a chain adapter or a note store.

import type { Mutex } from "../../core/async.js";
import { safeCall } from "../../core/callbacks.js";
import { buildNullifier, type Field, type Jubjub, type Poseidon } from "../../crypto/index.js";
import type { FullViewingKey, ViewingKey } from "../../keys/keys.js";
import type { NoteSource } from "../../sync/note-source.js";
import { type SyncOpts, type SyncResult, syncWallet } from "../../sync/notes-sync.js";
import type { NullifierStore } from "../../sync/nullifier-store.js";
import type { Scanner } from "../../sync/scanner.js";
import type { TreeStore } from "../../sync/tree-store.js";
import type { SyncOptions, SyncProgress, SyncReport } from "../types/sync.js";
import type { NoteCache } from "./note-cache.js";
import { type StoredNote, withinReservation } from "./note-store.js";

/** The narrow surface a sync needs. `WalletContext` and a watch wallet's context satisfy it. */
export interface SyncContext {
    readonly P: Poseidon;
    readonly J: Jubjub;
    /**
     * Scanning needs only `ivk`, so a `SpendingKey` or either viewing-key tier satisfies this.
     * {@link SyncContext.nullifiers} distinguishes them.
     */
    readonly keys: ViewingKey | FullViewingKey;
    readonly notes: NoteCache;
    readonly cfg: {
        readonly noteSource: NoteSource;
        readonly scanner: Scanner;
        readonly nullifierStore: NullifierStore;
        /** Absent on a watch wallet; the tree is read only to witness a spend. */
        readonly treeStore?: TreeStore | undefined;
    };
    /**
     * Note id → nullifier, memoised across passes. See {@link NullifierMemo}.
     *
     * Absent for an incoming-viewing-key holder, which has no `nk`; reconciliation is then skipped
     * and every note reads unspent.
     */
    readonly nullifiers?: NullifierMemo | undefined;
    readonly locks: {
        /**
         * Serialises syncs. A sync is `load` → scan → `save` over shared state, so overlapping
         * syncs (a poll timer and a user-initiated `sync()`) would interleave and the later save
         * would win. `NoteCache` serialises its writes but not the scan between them. Calls queue
         * rather than reject; the second is cheap because the first advanced the cursor.
         */
        readonly sync: Mutex;
    };
}

/**
 * Note id → nullifier, derived once per note rather than once per sync, so a reconcile pass costs
 * one Poseidon hash per newly seen note.
 *
 * Built from `nk`, so a full-viewing-key holder can construct one:
 * `nf = Poseidon(TAG_NF, nk, rho, cm)` requires no spend authority.
 *
 * In memory only. The notes file carries no `nsk`, so a leaked or backed-up file links its holder
 * to the user's on-chain commitments but not to their spends. Nullifiers are the on-chain spend
 * identifiers, so persisting them would expose that link.
 *
 * Keyed by `id` rather than note object because `cache.refresh()` may rehydrate new objects,
 * while ids are persisted and stable.
 */
export class NullifierMemo {
    private readonly byId = new Map<string, Field>();

    constructor(
        private readonly P: Poseidon,
        private readonly nk: Field,
    ) {}

    /** This note's nullifier, derived on first request. */
    of(n: StoredNote): Field {
        let nf = this.byId.get(n.id);
        if (nf === undefined) {
            nf = buildNullifier(this.P, this.nk, BigInt(n.rho), BigInt(n.cm));
            this.byId.set(n.id, nf);
        }
        return nf;
    }

    /** Entries currently held. The memo is bounded by the unspent-note count. */
    get size(): number {
        return this.byId.size;
    }

    /** Whether `id`'s nullifier is currently memoised. */
    has(id: string): boolean {
        return this.byId.has(id);
    }

    /**
     * Drop every entry outside `keep`, plus everything in `drop`.
     *
     * Called at the end of a reconcile pass with `keep` as the unspent notes and `drop` as those
     * this pass retired. Keeps the memo bounded, since only unspent notes are looked up again.
     */
    retain(keep: ReadonlySet<string>, drop: ReadonlySet<string>): void {
        for (const id of this.byId.keys()) {
            if (!keep.has(id) || drop.has(id)) this.byId.delete(id);
        }
    }
}

/**
 * Pull encrypted notes, trial-decrypt with `ivk + dk`, and persist hits.
 *
 * Scan only, without tree sync or reconciliation; see {@link syncScoped} for a whole sync.
 */
export function scanNotes(ctx: SyncContext, opts?: SyncOpts): Promise<SyncResult> {
    return syncWallet(
        {
            J: ctx.J,
            ivk: ctx.keys.ivk,
            source: ctx.cfg.noteSource,
            sink: ctx.notes,
            scanner: ctx.cfg.scanner,
        },
        opts ?? {},
    );
}

/**
 * Pull the spent set and reconcile, serialised with syncs.
 *
 * Called after the relayer refuses a spend because a nullifier is already spent, so the consumed
 * notes stop being offered.
 */
export function resyncSpent(ctx: SyncContext): Promise<void> {
    return ctx.locks.sync.run(async () => {
        await ctx.cfg.nullifierStore.sync();
        await reconcileSpentOnChain(ctx);
    });
}

/**
 * One sync of `scope`, unlocked: notes, the spent set (when the wallet can recompute nullifiers)
 * and, for `"full"`, the Merkle tree, in parallel; then reconcile which local notes are spent.
 *
 * `reload` re-reads the `NoteStore` first. Progress is tagged by stream; a throwing listener is
 * logged and swallowed. An abort stops each stream at its next page boundary, keeps what was
 * fetched (including the reconcile), then rejects with `signal.reason`.
 */
export async function syncScoped(
    ctx: SyncContext,
    scope: "notes" | "full",
    opts: SyncOptions = {},
): Promise<SyncReport> {
    const { signal } = opts;
    if (signal?.aborted) throw signal.reason;
    if (opts.reload) await ctx.notes.refresh();

    const listener = opts.onProgress;
    const emit = listener ? (p: SyncProgress) => safeCall("onProgress", listener, p) : undefined;
    const withSignal = signal ? { signal } : {};

    const [notes, tree, nullifiers] = await Promise.all([
        scanNotes(ctx, {
            ...withSignal,
            ...(opts.pageSize !== undefined ? { limit: opts.pageSize } : {}),
            ...(emit ? { onProgress: (p) => emit({ stream: "notes", ...p }) } : {}),
        }),
        scope === "full" && ctx.cfg.treeStore
            ? ctx.cfg.treeStore.sync({
                  ...withSignal,
                  ...(emit ? { onProgress: (p) => emit({ stream: "tree", ...p }) } : {}),
              })
            : undefined,
        // An incoming-tier key cannot recompute nullifiers, so the spent set is of no use to it.
        ctx.nullifiers
            ? ctx.cfg.nullifierStore.sync({
                  ...withSignal,
                  ...(emit ? { onProgress: (p) => emit({ stream: "nullifiers", ...p }) } : {}),
              })
            : undefined,
    ]);
    // Against the in-memory cache the scan just updated; `reload` is the caller's to ask for.
    await reconcileSpentOnChain(ctx);
    if (signal?.aborted) throw signal.reason;
    return {
        notes,
        ...(tree ? { tree } : {}),
        ...(nullifiers ? { nullifiers } : {}),
        syncedAt: new Date(),
    };
}

/**
 * Mark locally unspent notes whose nullifiers appear in the locally mirrored spent set.
 *
 * Purely local, since querying the server per nullifier would reveal the caller's notes. A stale
 * mirror only under-reports spends; it never marks a live note spent.
 *
 * A no-op without a {@link NullifierMemo}, since without `nk` there are no nullifiers to check.
 */
export async function reconcileSpentOnChain(ctx: SyncContext): Promise<void> {
    const memo = ctx.nullifiers;
    if (!memo) return;

    const candidates = ctx.notes.notes.filter((n) => !n.spent);
    const spentIds = new Set(
        candidates.filter((n) => ctx.cfg.nullifierStore.has(memo.of(n))).map((n) => n.id),
    );

    memo.retain(new Set(candidates.map((n) => n.id)), spentIds);

    // Release a reservation when the note is found spent, or when it has outlived
    // `SPEND_RESERVATION_MS` without its nullifier appearing (the spend did not land), which
    // returns the balance without a rescan.
    const now = Date.now();
    await ctx.notes.reconcile({
        spent: (n) => spentIds.has(n.id),
        release: (n) => spentIds.has(n.id) || !withinReservation(n.pendingSpendAt, now),
    });
}
