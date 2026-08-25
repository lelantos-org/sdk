// Sync orchestration: what to pull, in what order, and what to reconcile after.
//
// `./sync.ts` is the note-scanning engine — paging, trial decryption, the
// cursor. This is the layer above it: combining that scan with the tree and
// nullifier mirrors, and settling which local notes the chain now considers
// spent. It lived on `Wallet` until the class had ten methods of it.
//
// Depends on `SyncContext`, not on `Wallet`, for the reason `./context.ts`
// gives for `SpendContext`: these run against an object literal in a test,
// with no wasm, no chain adapter and no note store.

import { buildNullifierFromNsk, type Field, type Jubjub, type Poseidon } from "../crypto/index.js";
import type { SpendingKey } from "../keys/keys.js";
import type { Scanner } from "../sync/scanner.js";
import type { NoteCache } from "./note-cache.js";
import type { NoteSource } from "./note-source.js";
import { type StoredNote, withinReservation } from "./note-store.js";
import type { NullifierStore } from "./nullifier-store.js";
import { type SyncOpts, type SyncResult, syncWallet } from "./sync.js";
import type { TreeStore } from "./tree-store.js";

/** The narrow surface a sync operation needs. `Wallet` satisfies it as-is. */
export interface SyncContext {
    readonly P: Poseidon;
    readonly J: Jubjub;
    readonly keys: SpendingKey;

    readonly cache: NoteCache;
    readonly noteSource: NoteSource;
    readonly scanner: Scanner;
    readonly treeStore: TreeStore;
    readonly nullifierStore: NullifierStore;

    /** Note id → nullifier, memoised across passes. See {@link NullifierMemo}. */
    readonly nullifiers: NullifierMemo;
}

/**
 * Note id → nullifier, derived once per note rather than once per note per
 * sync — a reconcile pass costs one Poseidon per *newly seen* note.
 *
 * In memory only, deliberately. `StoredNote` is the persisted schema, and the
 * notes file carries no `nsk` — so a leaked or backed-up file today links its
 * holder to the user's on-chain commitments but not to their spends.
 * Nullifiers are exactly the on-chain spend identifiers; writing them into the
 * file would hand over that second half.
 *
 * Keyed by `id` rather than by the note object because `cache.refresh()` may
 * rehydrate new objects, while ids are persisted and stable.
 */
export class NullifierMemo {
    private readonly byId = new Map<string, Field>();

    constructor(
        private readonly P: Poseidon,
        private readonly nsk: Field,
    ) {}

    /** This note's nullifier, deriving it only the first time it is asked for. */
    of(n: StoredNote): Field {
        let nf = this.byId.get(n.id);
        if (nf === undefined) {
            nf = buildNullifierFromNsk(this.P, this.nsk, BigInt(n.rho), BigInt(n.cm));
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
     * Called at the end of a reconcile pass, where `keep` is the notes still
     * unspent and `drop` is the ones this pass just retired. Without it the
     * memo grows with every note the wallet has ever held, since only unspent
     * notes are ever looked up again.
     */
    retain(keep: ReadonlySet<string>, drop: ReadonlySet<string>): void {
        for (const id of this.byId.keys()) {
            if (!keep.has(id) || drop.has(id)) this.byId.delete(id);
        }
    }
}

/**
 * Pull encrypted notes, trial-decrypt with `ivk + dk`, persist hits.
 *
 * The scan alone — no tree, no reconcile. `syncNotes` is what callers want.
 */
export function scanNotes(ctx: SyncContext, opts?: SyncOpts): Promise<SyncResult> {
    return syncWallet(
        {
            J: ctx.J,
            ivk: ctx.keys.ivk,
            source: ctx.noteSource,
            sink: ctx.cache,
            scanner: ctx.scanner,
        },
        opts ?? {},
    );
}

/** Scan, mirror the spent set, then settle which local notes it retired. */
export async function syncNotesAndReconcile(
    ctx: SyncContext,
    opts?: SyncOpts,
): Promise<SyncResult> {
    const result = await scanNotes(ctx, opts);
    await ctx.nullifierStore.sync();
    // No `cache.refresh()`: `syncWallet` writes through `ctx.cache`, so the
    // snapshot reconciliation is about to read already holds the new notes.
    // Reloading here would have re-read the store instead — and reconciliation
    // would then persist whichever copy it happened to hold, erasing the
    // other's writes.
    await reconcileSpentOnChain(ctx);
    return result;
}

/**
 * Notes, tree and spent set in parallel, then reconcile.
 *
 * The three sources are independent, so they overlap; the reconcile has to
 * follow, because it reads the spent set the third one just refreshed.
 */
export async function syncAll(ctx: SyncContext, opts?: SyncOpts): Promise<SyncResult> {
    const signal = opts?.signal;
    const [result] = await Promise.all([
        scanNotes(ctx, opts),
        ctx.treeStore.sync(signal ? { signal } : {}),
        ctx.nullifierStore.sync(signal ? { signal } : {}),
    ]);
    // See `syncNotesAndReconcile` for why there is no `refresh()` here.
    await reconcileSpentOnChain(ctx);
    return result;
}

/**
 * Mark locally-unspent notes whose nullifiers are already consumed on chain,
 * against the locally mirrored spent set.
 *
 * Purely local: querying the server per nullifier would name the caller's own
 * notes. A stale mirror only ever under-reports spends; it never marks a live
 * note spent.
 */
export async function reconcileSpentOnChain(ctx: SyncContext): Promise<void> {
    const candidates = ctx.cache.notes.filter((n) => !n.spent);
    const spentIds = new Set(
        candidates.filter((n) => ctx.nullifierStore.has(ctx.nullifiers.of(n))).map((n) => n.id),
    );

    ctx.nullifiers.retain(new Set(candidates.map((n) => n.id)), spentIds);

    // A reservation stands in for exactly the answer this pass just fetched,
    // so it is released either way: a note found spent no longer needs one,
    // and one that outlived `SPEND_RESERVATION_MS` without its nullifier
    // appearing describes a spend that never landed — releasing it returns the
    // balance without a rescan.
    const now = Date.now();
    await ctx.cache.reconcile({
        spent: (n) => spentIds.has(n.id),
        release: (n) => spentIds.has(n.id) || !withinReservation(n.pendingSpendAt, now),
    });
}
