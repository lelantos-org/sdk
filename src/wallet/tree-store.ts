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

import type { Field, Poseidon } from "../crypto/index.js";
import { type MerkleProof, MerkleTree } from "../crypto/merkle.js";
import { TAG_LEAF } from "../crypto/tags.js";
import type { CommitmentChunkEntry, CommitmentChunkOut, FmdClient } from "./fmd-client.js";

const FETCH_WINDOW = 8;
const CHUNK_SIZE = 1024;
const TREE_DEPTH = 10;

export interface TreeStoreState {
    leaves: bigint[];
    syncedCount: number;
}

/// Plug in any storage backend to persist the Merkle tree across page loads.
///
/// @example
/// ```ts
/// class MyPersistence implements TreePersistence {
///     async load() { return JSON.parse(localStorage.getItem("tree") ?? "null"); }
///     async save(state) { localStorage.setItem("tree", JSON.stringify(state)); }
/// }
/// const wallet = await Wallet.connect({ ..., treePersistence: new MyPersistence() });
/// ```
export interface TreePersistence {
    load(): Promise<TreeStoreState | null>;
    save(state: TreeStoreState): Promise<void>;
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

    /// Build a TreeStore and restore any previously persisted state.
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

    /// Fetch new chunks since last sync and insert their leaves, then persist.
    ///
    /// Maintains a sliding window of FETCH_WINDOW parallel requests. Results
    /// are consumed in chunk-id order so tree insertion stays sequential. The
    /// window is abandoned once an incomplete chunk is seen — at most
    /// FETCH_WINDOW-1 speculative requests, each cheap (empty partial chunk).
    async sync(): Promise<void> {
        let nextFetch = Math.floor(this.syncedCount / CHUNK_SIZE);
        const inflight: Promise<CommitmentChunkOut>[] = [];

        for (;;) {
            while (inflight.length < FETCH_WINDOW) {
                inflight.push(this.fmd.fetchCommitmentChunk(nextFetch++));
            }
            const chunk = await inflight.shift()!;
            const newEntries = chunk.entries.filter((e) => e.leafIndex >= this.syncedCount);
            if (newEntries.length > 0) {
                this.tree.bulkInsert(newEntries.map((e) => this.computeLeaf(e)));
                this.syncedCount = newEntries[newEntries.length - 1].leafIndex + 1;
            }
            if (!chunk.isComplete) break;
        }

        if (this.persistence) await this.persistence.save(this.saveState());
    }

    getPath(leafIndex: number): MerkleProof & { root: Field } {
        return { ...this.tree.proof(leafIndex), root: this.tree.root() };
    }

    root(): Field {
        return this.tree.root();
    }

    private computeLeaf(entry: CommitmentChunkEntry): Field {
        const cm = hexToField(entry.cmHex);
        return this.P.hash([TAG_LEAF, cm, BigInt(entry.cvDepX), BigInt(entry.cvDepY)]);
    }
}

function hexToField(hex: string): bigint {
    const s = hex.startsWith("0x") ? hex.slice(2) : hex;
    return BigInt(`0x${s}`);
}
