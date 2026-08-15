// Local Merkle tree store: syncs commitment chunks from the server and computes
// Merkle paths without revealing which note is being spent.
//
// Leaves arrive pre-hashed: the server sends `Poseidon(TAG_LEAF, cm, cv_dep_x,
// cv_dep_y)` per entry, so this file no longer hashes anything at the leaf
// level and `Poseidon` is used only for the internal nodes. `verifyRoot` is
// what checks the server was telling the truth.
//
// Paging over the chunk feed lives in `./chunk-feed.js`; this file only keeps
// the leaves in order.
//
// Persistence: pass a `TreePersistence` to `TreeStore.withPersistence`;
// `load` runs once at startup, `save` after every successful `sync()`.

import type { Field, Poseidon } from "../crypto/index.js";
import { type MerkleNode, type MerkleProof, MerkleTree } from "../crypto/merkle.js";
import type { FmdClient } from "../services/fmd-server/client.js";
import { chunkOf, type PagingOpts, type PagingStop, pageChunks, TREE_DEPTH } from "./chunk-feed.js";

// Re-exported because `TreeStoreState.nodes` is typed by it: a
// `TreePersistence` implementation cannot be written without naming it.
export type { MerkleNode };

export interface TreeStoreState {
    leaves: bigint[];
    syncedCount: number;
    /**
     * Memoized internal Merkle nodes.
     *
     * Optional: a state without them still loads, it just pays the full
     * ~350K-hash rebuild on the first `root()`/`getPath()` after restore.
     */
    nodes?: MerkleNode[] | undefined;
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
    onProgress?:
        | ((p: { chunkId: number; leaves: number; syncedCount: number }) => void)
        | undefined;
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
        // Order matters: `setLeaves` clears the node cache.
        this.tree.setLeaves(state.leaves);
        if (state.nodes) this.tree.importNodes(state.nodes);
        this.syncedCount = state.syncedCount;
    }

    saveState(): TreeStoreState {
        return {
            leaves: [...this.tree.leaves],
            syncedCount: this.syncedCount,
            nodes: this.tree.exportNodes(),
        };
    }

    /**
     * Fetch new chunks since last sync, insert their leaves, then persist.
     * Idempotent — the tail chunk is re-fetched every sync, so entries already
     * in the tree are dropped by leaf index rather than re-inserted.
     */
    async sync(opts: TreeSyncOpts = {}): Promise<TreeSyncSummary> {
        const startCount = this.syncedCount;

        try {
            const { chunksFetched, stoppedBy } = await pageChunks(
                (chunkId) => this.fmd.fetchCommitmentChunk(chunkId),
                chunkOf(this.syncedCount),
                (chunk) => {
                    const fresh = chunk.entries.filter((e) => e.leafIndex >= this.syncedCount);
                    if (fresh.length > 0) {
                        this.tree.bulkInsert(fresh.map((e) => e.leafHash));
                        this.syncedCount = fresh[fresh.length - 1]!.leafIndex + 1;
                    }
                    opts.onProgress?.({
                        chunkId: chunk.chunkId,
                        leaves: fresh.length,
                        syncedCount: this.syncedCount,
                    });
                },
                { maxChunks: opts.maxChunks, signal: opts.signal, feed: "commitments" },
            );

            return {
                chunksFetched,
                leavesAdded: this.syncedCount - startCount,
                syncedCount: this.syncedCount,
                stoppedBy,
            };
        } finally {
            // In `finally`, and gated on the cursor rather than on success.
            //
            // A chunk failure mid-sync leaves every chunk consumed before it
            // already folded into `this.tree`, so the in-memory cursor has
            // moved even though the sync threw. Skipping the save there means
            // a reload re-downloads and re-hashes all of it — on a cold sync,
            // potentially the entire tree. Saving here turns that into a
            // resume.
            //
            // The guard is `syncedCount`, not `chunksFetched`: the tail chunk
            // is re-fetched every sync, so a steady-state poll always fetches
            // at least one chunk while adding no leaves, and serialising a
            // 1M-leaf tree for that is pure cost.
            if (this.syncedCount > startCount) {
                // Force the internal nodes to be built before snapshotting.
                //
                // The cache fills lazily on the first `root()`/`getPath()`, so
                // saving straight after a sync would persist an empty one and
                // the restore would gain nothing. Doing it here also moves the
                // hashing off the spend path — it happens while a sync is
                // already in progress and observable, rather than stalling the
                // first transaction the user tries to make.
                this.tree.root();
                await this.persistence?.save(this.saveState());
            }
        }
    }

    getPath(leafIndex: number): MerkleProof & { root: Field } {
        return { ...this.tree.proof(leafIndex), root: this.tree.root() };
    }

    root(): Field {
        return this.tree.root();
    }

    /**
     * Check the locally built root against the one the chain holds.
     *
     * Worth doing on its own merits — nothing verified the local tree before —
     * and it is the guard that makes trusting the server's `leafHash` sound:
     * a wrong leaf produces a wrong root, and this is where that surfaces,
     * rather than as an unexplained rejected transaction later.
     *
     * Returns `true` when they agree. A mismatch is not necessarily an attack:
     * the mirror lags the chain, so a tree synced mid-block legitimately
     * differs. Callers should treat a mismatch as "resync and retry".
     */
    async verifyRoot(): Promise<boolean> {
        const state = await this.fmd.fetchTreeState();
        return state.root === this.root();
    }
}
