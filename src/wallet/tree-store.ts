// Local Merkle tree store: syncs commitment chunks from the server and computes
// Merkle paths without revealing which note is being spent.
//
// Leaf hash: Poseidon(TAG_LEAF, cm, cv_dep_x, cv_dep_y) — matches the server.
// Chunk size: 1024 (power of 4, aligns to quaternary tree levels).
// Complete chunks are CDN-immutable; only the last partial chunk is re-fetched.
//
// sync() fetches up to FETCH_WINDOW chunks in parallel (complete chunks are
// served from CDN so parallel fetches are effectively free), then inserts
// leaves sequentially to reconstruct the tree in order.
//
// Persistence: pass a `TreePersistence` to `TreeStore.withPersistence`;
// `load` runs once at startup, `save` after every successful `sync()`.

import { hexToBigint } from "../core/hex.js";
import type { Field, Poseidon } from "../crypto/index.js";
import { type MerkleProof, MerkleTree } from "../crypto/merkle.js";
import { TAG_LEAF } from "../crypto/tags.js";
import { getLogger } from "../log/logger.js";
import type {
    CommitmentChunkEntry,
    CommitmentChunkOut,
    FmdClient,
} from "../services/fmd-server/client.js";

const FETCH_WINDOW = 8;
const CHUNK_SIZE = 1024;
const TREE_DEPTH = 10;

export interface TreeStoreState {
    leaves: bigint[];
    syncedCount: number;
}

/**
 * Plug in any storage backend to persist the Merkle tree across page loads.
 *
 * @example
 * ```ts
 * class MyPersistence implements TreePersistence {
 *     async load() { return JSON.parse(localStorage.getItem("tree") ?? "null"); }
 *     async save(state) { localStorage.setItem("tree", JSON.stringify(state)); }
 * }
 * const wallet = await connect({ ..., treePersistence: new MyPersistence() });
 * ```
 */
export interface TreePersistence {
    load(): Promise<TreeStoreState | null>;
    save(state: TreeStoreState): Promise<void>;
}

const log = getLogger("lelantos:wallet:tree");

export interface TreeSyncOpts {
    /** Per-chunk progress, so a stuck sync is observable. */
    onProgress?: (p: { chunkId: number; leaves: number; syncedCount: number }) => void;
    /** Defaults to the tree's capacity in chunks — never unbounded. */
    maxChunks?: number;
    signal?: AbortSignal;
}

export interface TreeSyncSummary {
    chunksFetched: number;
    leavesAdded: number;
    syncedCount: number;
    stoppedBy: "complete" | "maxChunks" | "aborted";
}

export class TreeStore {
    private tree: MerkleTree;
    private syncedCount = 0;
    private persistence?: TreePersistence;

    constructor(
        private readonly P: Poseidon,
        private readonly fmd: FmdClient,
    ) {
        this.tree = new MerkleTree(P, TREE_DEPTH);
    }

    /** Build a TreeStore and restore any previously persisted state. */
    static async withPersistence(
        P: Poseidon,
        fmd: FmdClient,
        persistence: TreePersistence,
    ): Promise<TreeStore> {
        const store = new TreeStore(P, fmd);
        store.persistence = persistence;
        const saved = await persistence.load();
        if (saved) store.loadState(saved);
        return store;
    }

    loadState(state: TreeStoreState): void {
        this.tree = new MerkleTree(this.P, TREE_DEPTH);
        this.tree.setLeaves(state.leaves);
        this.syncedCount = state.syncedCount;
    }

    saveState(): TreeStoreState {
        return { leaves: [...this.tree.leaves], syncedCount: this.syncedCount };
    }

    /**
     * Fetch new chunks since last sync and insert their leaves, then persist.
     *
     * Maintains a sliding window of FETCH_WINDOW parallel requests. Results
     * are consumed in chunk-id order so tree insertion stays sequential. The
     * window is abandoned once an incomplete chunk is seen — at most
     * FETCH_WINDOW-1 speculative requests, each cheap (empty partial chunk).
     *
     * The loop is bounded: the tree holds `arity^depth` leaves, so the chunk
     * count has a hard ceiling even against a server that always answers
     * `isComplete`.
     */
    async sync(opts: TreeSyncOpts = {}): Promise<TreeSyncSummary> {
        const maxChunks = opts.maxChunks ?? Math.ceil(4 ** TREE_DEPTH / CHUNK_SIZE);
        const startCount = this.syncedCount;
        let nextFetch = Math.floor(this.syncedCount / CHUNK_SIZE);
        const inflight: Promise<CommitmentChunkOut>[] = [];

        let chunksFetched = 0;
        let stoppedBy: TreeSyncSummary["stoppedBy"] = "complete";

        for (;;) {
            if (opts.signal?.aborted) {
                stoppedBy = "aborted";
                break;
            }
            if (chunksFetched >= maxChunks) {
                stoppedBy = "maxChunks";
                log.warn("tree sync hit the chunk cap", {
                    maxChunks,
                    syncedCount: this.syncedCount,
                });
                break;
            }
            while (inflight.length < FETCH_WINDOW) {
                inflight.push(this.fmd.fetchCommitmentChunk(nextFetch++));
            }
            const chunk = await inflight.shift()!;
            chunksFetched++;

            const newEntries = chunk.entries.filter((e) => e.leafIndex >= this.syncedCount);
            if (newEntries.length > 0) {
                this.tree.bulkInsert(newEntries.map((e) => this.computeLeaf(e)));
                this.syncedCount = newEntries[newEntries.length - 1].leafIndex + 1;
            }
            opts.onProgress?.({
                chunkId: chunk.chunkId,
                leaves: newEntries.length,
                syncedCount: this.syncedCount,
            });
            if (!chunk.isComplete) break;
        }

        if (this.persistence) await this.persistence.save(this.saveState());

        return {
            chunksFetched,
            leavesAdded: this.syncedCount - startCount,
            syncedCount: this.syncedCount,
            stoppedBy,
        };
    }

    getPath(leafIndex: number): MerkleProof & { root: Field } {
        return { ...this.tree.proof(leafIndex), root: this.tree.root() };
    }

    root(): Field {
        return this.tree.root();
    }

    private computeLeaf(entry: CommitmentChunkEntry): Field {
        const cm = hexToBigint(entry.cmHex);
        return this.P.hash([TAG_LEAF, cm, BigInt(entry.cvDepX), BigInt(entry.cvDepY)]);
    }
}
