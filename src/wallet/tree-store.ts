// Local Merkle tree store: syncs commitment chunks from the server and computes
// Merkle paths without revealing which note is being spent.
//
// Leaf hash: Poseidon(TAG_LEAF, cm, cv_dep_x, cv_dep_y) — matches the server.
// Paging over the chunk feed lives in `./chunk-feed.js`; this file only turns
// the entries into leaves and keeps the tree in order.
//
// Persistence: pass a `TreePersistence` to `TreeStore.withPersistence`;
// `load` runs once at startup, `save` after every successful `sync()`.

import type { Field, Poseidon } from "../crypto/index.js";
import { type MerkleProof, MerkleTree } from "../crypto/merkle.js";
import { TAG_LEAF } from "../crypto/tags.js";
import type { CommitmentChunkEntry, FmdClient } from "../services/fmd-server/client.js";
import { chunkOf, type PagingOpts, type PagingStop, pageChunks, TREE_DEPTH } from "./chunk-feed.js";

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

export interface TreeSyncOpts extends PagingOpts {
    /** Per-chunk progress, so a stuck sync is observable. */
    onProgress?: (p: { chunkId: number; leaves: number; syncedCount: number }) => void;
}

export interface TreeSyncSummary {
    chunksFetched: number;
    leavesAdded: number;
    syncedCount: number;
    stoppedBy: PagingStop;
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
     * Fetch new chunks since last sync, insert their leaves, then persist.
     * Idempotent — the tail chunk is re-fetched every sync, so entries already
     * in the tree are dropped by leaf index rather than re-inserted.
     */
    async sync(opts: TreeSyncOpts = {}): Promise<TreeSyncSummary> {
        const startCount = this.syncedCount;

        const { chunksFetched, stoppedBy } = await pageChunks(
            (chunkId) => this.fmd.fetchCommitmentChunk(chunkId),
            chunkOf(this.syncedCount),
            (chunk) => {
                const fresh = chunk.entries.filter((e) => e.leafIndex >= this.syncedCount);
                if (fresh.length > 0) {
                    this.tree.bulkInsert(fresh.map((e) => this.computeLeaf(e)));
                    this.syncedCount = fresh[fresh.length - 1].leafIndex + 1;
                }
                opts.onProgress?.({
                    chunkId: chunk.chunkId,
                    leaves: fresh.length,
                    syncedCount: this.syncedCount,
                });
            },
            { maxChunks: opts.maxChunks, signal: opts.signal, feed: "commitments" },
        );

        await this.persistence?.save(this.saveState());

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
        return this.P.hash([TAG_LEAF, entry.cm, entry.cvDep[0], entry.cvDep[1]]);
    }
}
