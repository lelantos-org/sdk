// Local spent-nullifier set: pages the server's nullifier chunk feed and
// answers "is this note already spent?" without a network round-trip.
//
// The server exposes no spent query: asking "is nullifier N spent?" names a
// note the caller owns. The whole set is mirrored locally and filtered here
// instead.
//
// Paging over the chunk feed lives in `./chunk-feed.js`; this file only tracks
// which entries it has already folded in. Entries are ordered by insertion, so
// a chunk's k-th entry has sequence `chunkId * CHUNK_SIZE + k`.
//
// Entries arrive truncated — see `WIRE_BYTES` — so everything held here is the
// low-bit slice of a nullifier, never a field element.
//
// Persistence: pass a `NullifierPersistence` to
// `NullifierStore.withPersistence`; `load` runs once at startup, `save` after
// every successful `sync()`.

import type { Field } from "../crypto/index.js";
import type { FmdClient } from "../services/fmd-server/client.js";
import { CHUNK_SIZE, chunkOf, type PagingOpts, type PagingStop, pageChunks } from "./chunk-feed.js";

/**
 * Bytes of a nullifier the server sends, taken from the low end. Must match
 * `WIRE_BYTES` in the server's `services::nullifiers`.
 *
 * The feed is downloaded in full by every wallet, so the other 22 bytes are
 * pure wire cost — nothing here compares more than set membership. The spent
 * set is bounded by the tree's `4^10` leaves, putting the chance a live note
 * collides with it at `2^20 / 2^80 = 2^-60`; a collision would make this store
 * report a live note as spent, costing that note's spendability in this
 * client, not the note.
 */
const WIRE_BYTES = 10;
const WIRE_MASK = (1n << BigInt(WIRE_BYTES * 8)) - 1n;

/** Reduces a nullifier to the form the feed carries. */
function truncate(nf: Field): bigint {
    return nf & WIRE_MASK;
}

export interface NullifierStoreState {
    /** Truncated per `WIRE_BYTES`, so not usable as field elements. */
    nullifiers: bigint[];
    syncedCount: number;
}

/**
 * Plug in any storage backend to persist the spent set across page loads.
 *
 * @example
 * ```ts
 * const wallet = await connect({ ..., nullifierPersistence: myBackend });
 * ```
 */
export interface NullifierPersistence {
    load(): Promise<NullifierStoreState | null>;
    save(state: NullifierStoreState): Promise<void>;
}

export interface NullifierSyncOpts extends PagingOpts {
    /** Per-chunk progress, so a stuck sync is observable. */
    onProgress?: ((p: { chunkId: number; added: number; syncedCount: number }) => void) | undefined;
}

export interface NullifierSyncSummary {
    chunksFetched: number;
    added: number;
    syncedCount: number;
    stoppedBy: PagingStop;
}

export class NullifierStore {
    private spent = new Set<bigint>();
    private syncedCount = 0;
    private persistence?: NullifierPersistence;

    constructor(private readonly fmd: FmdClient) {}

    /** Build a NullifierStore and restore any previously persisted state. */
    static async withPersistence(
        fmd: FmdClient,
        persistence: NullifierPersistence,
    ): Promise<NullifierStore> {
        const store = new NullifierStore(fmd);
        store.persistence = persistence;
        const saved = await persistence.load();
        if (saved) store.loadState(saved);
        return store;
    }

    loadState(state: NullifierStoreState): void {
        this.spent = new Set(state.nullifiers);
        this.syncedCount = state.syncedCount;
    }

    saveState(): NullifierStoreState {
        return { nullifiers: [...this.spent], syncedCount: this.syncedCount };
    }

    /**
     * Fetch new chunks since last sync, fold them into the set, then persist.
     * Idempotent — the tail chunk is re-fetched every sync, so entries already
     * mirrored are dropped by sequence rather than counted twice.
     */
    async sync(opts: NullifierSyncOpts = {}): Promise<NullifierSyncSummary> {
        const startCount = this.syncedCount;

        try {
            const { chunksFetched, stoppedBy } = await pageChunks(
                (chunkId) => this.fmd.fetchNullifierChunk(chunkId),
                chunkOf(this.syncedCount),
                (chunk) => {
                    const base = chunk.chunkId * CHUNK_SIZE;
                    const fresh = chunk.nullifiers.slice(Math.max(0, this.syncedCount - base));
                    for (const nf of fresh) this.spent.add(nf);
                    this.syncedCount = Math.max(this.syncedCount, base + chunk.nullifiers.length);
                    opts.onProgress?.({
                        chunkId: chunk.chunkId,
                        added: fresh.length,
                        syncedCount: this.syncedCount,
                    });
                },
                { maxChunks: opts.maxChunks, signal: opts.signal, feed: "nullifiers" },
            );

            return {
                chunksFetched,
                added: this.syncedCount - startCount,
                syncedCount: this.syncedCount,
                stoppedBy,
            };
        } finally {
            // Same reasoning as `TreeStore.sync`: persist on partial progress
            // so a failed page resumes, and skip the write entirely when the
            // cursor did not move, which is every steady-state poll.
            if (this.syncedCount > startCount) {
                await this.persistence?.save(this.saveState());
            }
        }
    }

    /**
     * True if this nullifier was consumed on chain as of the last sync. A
     * stale mirror only ever under-reports, so this never marks a live note
     * spent.
     */
    has(nf: Field): boolean {
        return this.spent.has(truncate(nf));
    }

    /** Nullifiers mirrored so far. */
    get size(): number {
        return this.spent.size;
    }
}
