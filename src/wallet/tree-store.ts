// Local Merkle tree store: syncs commitment chunks from the server and computes
// Merkle paths without revealing which note is being spent.
//
// Leaf hash: Poseidon(TAG_LEAF, cm, cv_dep_x, cv_dep_y) — matches the server.
// Chunk size: 1024 (power of 4, aligns to quaternary tree levels).
// Complete chunks are CDN-immutable; only the last partial chunk is re-fetched.

import type { Field, Poseidon } from "../crypto/index.js";
import { type MerkleProof, MerkleTree } from "../crypto/merkle.js";
import { TAG_LEAF } from "../crypto/tags.js";
import type { CommitmentChunkEntry, FmdClient } from "./fmd-client.js";

const CHUNK_SIZE = 1024;
const TREE_DEPTH = 10;

export interface TreeStoreState {
    /// Merkle leaf field elements in insertion order (leaf_index = array index).
    leaves: bigint[];
    /// Number of leaves synced (= leaves.length). Used as cursor.
    syncedCount: number;
}

export class TreeStore {
    private tree: MerkleTree;
    private syncedCount = 0;

    constructor(
        private readonly P: Poseidon,
        private readonly fmd: FmdClient,
    ) {
        this.tree = new MerkleTree(P, TREE_DEPTH);
    }

    /// Restore from a previously persisted state (e.g. IndexedDB).
    loadState(state: TreeStoreState): void {
        this.tree = new MerkleTree(this.P, TREE_DEPTH);
        for (const leaf of state.leaves) {
            this.tree.insert(leaf);
        }
        this.syncedCount = state.syncedCount;
    }

    /// Snapshot for persistence.
    saveState(): TreeStoreState {
        return {
            leaves: [...this.tree.leaves],
            syncedCount: this.syncedCount,
        };
    }

    /// Fetch any new chunks since last sync and insert their leaves.
    async sync(): Promise<void> {
        let chunkId = Math.floor(this.syncedCount / CHUNK_SIZE);
        for (;;) {
            const chunk = await this.fmd.fetchCommitmentChunk(chunkId);
            for (const entry of chunk.entries) {
                if (entry.leafIndex < this.syncedCount) continue;
                const leaf = this.computeLeaf(entry);
                this.tree.insert(leaf);
                this.syncedCount = entry.leafIndex + 1;
            }
            if (!chunk.isComplete) break;
            chunkId++;
        }
    }

    /// Compute Merkle proof for `leafIndex`. Call `sync()` first if potentially stale.
    getPath(leafIndex: number): MerkleProof & { root: Field } {
        const proof = this.tree.proof(leafIndex);
        const root = this.tree.root();
        return { ...proof, root };
    }

    root(): Field {
        return this.tree.root();
    }

    private computeLeaf(entry: CommitmentChunkEntry): Field {
        const cm = hexToField(entry.cmHex);
        const cvX = BigInt(entry.cvDepX);
        const cvY = BigInt(entry.cvDepY);
        return this.P.hash([TAG_LEAF, cm, cvX, cvY]);
    }
}

function hexToField(hex: string): bigint {
    const s = hex.startsWith("0x") ? hex.slice(2) : hex;
    return BigInt(`0x${s}`);
}
