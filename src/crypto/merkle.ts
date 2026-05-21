// Quaternary sparse Merkle tree, Poseidon-arity-5 nodes:
//   node = Poseidon(TAG_MERKLE, c0, c1, c2, c3)
// Mirrors `circuits/src/lib/merkle.circom`.
//
// Internal nodes are memoized in `nodeCache`. On insert, only the O(depth)
// dirty path from leaf to root is evicted. bulkInsert evicts the minimal
// range instead of per-leaf paths, saving ~7.5× cache operations per chunk.

import type { Field, Poseidon } from "./poseidon.js";
import { TAG_MERKLE } from "./tags.js";

const ARITY = 4;

/** @internal */
export interface MerkleProof {
    pathElements: Field[][];
    pathIndices: number[];
}

/** @internal */
export class MerkleTree {
    leaves: Field[] = [];
    private readonly zeros: Field[] = [];
    private readonly strides: number[];
    private readonly nodeCache = new Map<number, Field>();

    constructor(
        private readonly P: Poseidon,
        readonly depth: number,
    ) {
        let z: Field = 0n;
        for (let i = 0; i < depth; i++) {
            this.zeros.push(z);
            z = this.hashNode(z, z, z, z);
        }
        this.zeros.push(z);
        this.strides = Array.from({ length: depth + 1 }, (_, i) => ARITY ** i);
    }

    insert(leaf: Field): number {
        const idx = this.leaves.push(leaf) - 1;
        this.invalidatePath(idx);
        return idx;
    }

    /// Insert multiple leaves and evict only the minimal dirty range.
    /// Use instead of repeated insert() when adding a contiguous block.
    bulkInsert(leaves: Field[]): void {
        if (leaves.length === 0) return;
        const lo = this.leaves.length;
        for (const leaf of leaves) this.leaves.push(leaf);
        this.invalidateRange(lo, this.leaves.length - 1);
    }

    /// Directly set the leaf array without cache invalidation.
    /// Only safe on a freshly constructed tree (empty cache).
    setLeaves(leaves: Field[]): void {
        this.leaves = [...leaves];
    }

    root(): Field {
        return this.nodeAt(this.depth, 0);
    }

    /// Frontier snapshot for the lazy-root tree-update circuit. Returns `depth × 3` slots.
    /// For each level `lvl` and slot `k ∈ {0,1,2}`:
    ///   frontier[lvl][k] = nodeAt(lvl, parentIdx * 4 + k)   if k < currentSlot
    ///   frontier[lvl][k] = 0                                  otherwise
    /// where `currentSlot = (N / 4^lvl) % 4`, `parentIdx = N / 4^(lvl+1)`, `N = leaves.length`.
    /// k ≥ currentSlot entries are not read by the next insert; zeroed deterministically.
    frontier(): Field[][] {
        const N = this.leaves.length;
        const out: Field[][] = [];
        for (let lvl = 0; lvl < this.depth; lvl++) {
            const stride = this.strides[lvl];
            const slot = Math.floor(N / stride) % ARITY;
            const parentIdx = Math.floor(N / (stride * ARITY));
            const slots: Field[] = [];
            for (let k = 0; k < 3; k++) {
                if (k < slot) {
                    slots.push(this.nodeAt(lvl, parentIdx * ARITY + k));
                } else {
                    slots.push(0n);
                }
            }
            out.push(slots);
        }
        return out;
    }

    /// Quaternary digits of `leafIndex` from level 0 to level depth-1. Each digit ∈ {0,1,2,3}.
    /// Matches the Num2Bits decomposition the circuit performs internally.
    pathIndicesAt(leafIndex: number): number[] {
        const out: number[] = [];
        let idx = leafIndex;
        for (let lvl = 0; lvl < this.depth; lvl++) {
            out.push(idx % ARITY);
            idx = Math.floor(idx / ARITY);
        }
        return out;
    }

    proof(leafIndex: number): MerkleProof {
        const pathElements: Field[][] = [];
        const pathIndices: number[] = [];
        let idx = leafIndex;

        for (let level = 0; level < this.depth; level++) {
            const selfPos = idx % ARITY;
            const parentIdx = Math.floor(idx / ARITY);
            const siblings: Field[] = [];
            for (let k = 0; k < ARITY; k++) {
                if (k !== selfPos) siblings.push(this.nodeAt(level, parentIdx * ARITY + k));
            }
            pathElements.push(siblings);
            pathIndices.push(selfPos);
            idx = parentIdx;
        }
        return { pathElements, pathIndices };
    }

    private nodeAt(level: number, index: number): Field {
        if (level === 0) return this.leaves[index] ?? 0n;
        if (index * this.strides[level] >= this.leaves.length) return this.zeros[level];

        const key = this.cacheKey(level, index);
        const cached = this.nodeCache.get(key);
        if (cached !== undefined) return cached;

        const firstChild = index * ARITY;
        const value = this.hashNode(
            this.nodeAt(level - 1, firstChild),
            this.nodeAt(level - 1, firstChild + 1),
            this.nodeAt(level - 1, firstChild + 2),
            this.nodeAt(level - 1, firstChild + 3),
        );
        this.nodeCache.set(key, value);
        return value;
    }

    private invalidatePath(leafIndex: number): void {
        let idx = Math.floor(leafIndex / ARITY);
        for (let level = 1; level <= this.depth; level++) {
            this.nodeCache.delete(this.cacheKey(level, idx));
            idx = Math.floor(idx / ARITY);
        }
    }

    // Evict all internal nodes whose subtrees overlap [lo, hi] at every level.
    private invalidateRange(lo: number, hi: number): void {
        let loIdx = Math.floor(lo / ARITY);
        let hiIdx = Math.floor(hi / ARITY);
        for (let level = 1; level <= this.depth; level++) {
            for (let i = loIdx; i <= hiIdx; i++) {
                this.nodeCache.delete(this.cacheKey(level, i));
            }
            loIdx = Math.floor(loIdx / ARITY);
            hiIdx = Math.floor(hiIdx / ARITY);
        }
    }

    // Encodes (level, index) as a single number. Level ≤ 10, index < 4^9 = 262144 (< 2^18).
    private cacheKey(level: number, index: number): number {
        return (level << 18) | index;
    }

    private hashNode(c0: Field, c1: Field, c2: Field, c3: Field): Field {
        return this.P.hash([TAG_MERKLE, c0, c1, c2, c3]);
    }
}
