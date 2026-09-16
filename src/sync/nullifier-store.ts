// Local spent-nullifier set: mirrors the server's nullifier chunk feed and answers whether a note
// is spent without a network round-trip.
//
// The server exposes no spent query, since asking whether nullifier N is spent reveals a note the
// caller owns. The whole set is mirrored and queried locally.
//
// Paging lives in `./chunk-feed.js`; this file tracks which entries are folded in. Entries are
// ordered by insertion, so a chunk's k-th entry has sequence `chunkId * CHUNK_SIZE + k`.
//
// Entries are truncated (see `WIRE_BYTES`), so every value held here is the low-bit slice of a
// nullifier, not a field element.
//
// Persistence: pass a `NullifierPersistence` to `NullifierStore.withPersistence`; `load` runs once
// at startup, `save` after each `sync()` that advances the cursor.

import type { Field } from "../crypto/index.js";
import { WireFormatError } from "../errors/network.js";
import type { NullifierChunkOut } from "../services/fmd-server/wire.js";
import { CHUNK_SIZE, chunkOf, type PagingOpts, type PagingStop, pageChunks } from "./chunk-feed.js";

/** Where a `NullifierStore` reads the spent set from. `FmdClient` implements it. */
export interface NullifierFeed {
    fetchNullifierChunk(
        chunkId: number,
        opts?: { signal?: AbortSignal | undefined },
    ): Promise<NullifierChunkOut>;
}

/**
 * Low-end bytes of each nullifier the server sends. Must match `WIRE_BYTES` in the server's
 * `services::nullifiers`.
 *
 * Every wallet downloads the full feed and only tests set membership, so the remaining 22 bytes
 * are omitted. The spent set is bounded by the tree's `4^10` leaves, so the probability that a
 * live note collides is `2^20 / 2^80 = 2^-60`; a collision makes this client report the note as
 * spent, affecting spendability in this client only, not the note itself.
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
 * Storage backend that persists the spent set across page loads.
 *
 * `NullifierStoreState.nullifiers` is `bigint[]`, which `JSON.stringify` cannot serialise, so a
 * JSON backend must encode it; see `TreePersistence` in `./tree-store.ts` for the `0x`-hex
 * convention. A structured-clone backend (IndexedDB) stores `bigint` directly.
 *
 * @example
 * ```ts
 * const wallet = await connect({ ..., storage: { nullifiers: myBackend } });
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

    constructor(private readonly fmd: NullifierFeed) {}

    /** Build a NullifierStore and restore any previously persisted state. */
    static async withPersistence(
        fmd: NullifierFeed,
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
     * Fetch chunks since the last sync, fold them into the set, then persist. Idempotent: the
     * tail chunk is re-fetched every sync and already-mirrored entries are skipped by sequence.
     */
    async sync(opts: NullifierSyncOpts = {}): Promise<NullifierSyncSummary> {
        const startCount = this.syncedCount;
        // `pageChunks` folds in chunk-id order from here, so each chunk's expected id is known.
        const firstChunkId = chunkOf(this.syncedCount);
        let expectedChunkId = firstChunkId;

        try {
            const { chunksFetched, stoppedBy } = await pageChunks(
                (chunkId, signal) => this.fmd.fetchNullifierChunk(chunkId, { signal }),
                firstChunkId,
                (chunk) => {
                    assertWellFormed(chunk, expectedChunkId++);
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
            // Persisted even when a page failed, so the next sync resumes from the partial progress;
            // skipped when the cursor did not move (every steady-state poll).
            if (this.syncedCount > startCount) {
                await this.persistence?.save(this.saveState());
            }
        }
    }

    /**
     * True if this nullifier was consumed on-chain as of the last sync. A stale mirror can only
     * under-report, so this never reports a live note as spent (barring the truncation collision
     * described at `WIRE_BYTES`).
     */
    has(nf: Field): boolean {
        return this.spent.has(truncate(nf));
    }

    /** Nullifiers mirrored so far. */
    get size(): number {
        return this.spent.size;
    }
}

/**
 * Reject a chunk that does not sit exactly where the fold expects it.
 *
 * Position is implied, as for commitments: a chunk's k-th entry has sequence
 * `chunkId * CHUNK_SIZE + k`, and `syncedCount` advances by the chunk's length. An over-long chunk
 * would push `syncedCount` into the next chunk's range, so the next fold's
 * `slice(syncedCount - base)` would drop that many real entries. Their notes would never be
 * marked spent by `reconcileSpentOnChain`, and the selector would keep offering them.
 *
 * `TreeStore` applies the equivalent check in `assertContiguous`.
 */
function assertWellFormed(chunk: NullifierChunkOut, expectedChunkId: number): void {
    if (chunk.chunkId !== expectedChunkId) {
        throw new WireFormatError(
            "$.chunkId",
            `nullifier chunk is ${chunk.chunkId}, expected ${expectedChunkId}`,
        );
    }
    if (chunk.nullifiers.length > CHUNK_SIZE) {
        throw new WireFormatError(
            "$.nullifiers",
            `nullifier chunk ${chunk.chunkId} has ${chunk.nullifiers.length} entries, ` +
                `at most ${CHUNK_SIZE}`,
        );
    }
    if (chunk.isComplete && chunk.nullifiers.length !== CHUNK_SIZE) {
        throw new WireFormatError(
            "$.nullifiers",
            `nullifier chunk ${chunk.chunkId} is marked complete with ` +
                `${chunk.nullifiers.length} entries, expected ${CHUNK_SIZE}`,
        );
    }
    // Entries must already be truncated to `WIRE_BYTES`. A full-width entry would never match the
    // truncated lookup in `has()`, so its note would never be marked spent.
    for (const nf of chunk.nullifiers) {
        if (nf < 0n || nf > WIRE_MASK) {
            throw new WireFormatError(
                "$.nullifiers",
                `nullifier chunk ${chunk.chunkId} carries an entry wider than ` +
                    `${WIRE_BYTES} bytes`,
            );
        }
    }
}
