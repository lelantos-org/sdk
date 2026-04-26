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

// Beyond this the (level, index) cache key would exceed 2^53.
const MAX_DEPTH = 25;

/**
 * Stride that makes `level * stride + index` injective over every
 * (level, index) the tree can reach.
 *
 * At level L a cached index is < 4^(depth-L), so the widest level is L=1
 * with indices < 4^(depth-1) = 2^(2·depth-2). Anything smaller aliases one
 * level into the next.
 *
 * The previous implementation hardcoded 2^18. That is exactly right at
 * depth 10 — capacity 4^10 leaves puts the largest level-1 index at
 * 2^18 - 1 — and silently wrong for any deeper tree, where a level-1 index
 * runs past the stride and collides with a level-2 key.
 *
 * @internal exported for the injectivity test; not part of the public API.
 */
export function cacheKeyStride(depth: number): number {
    return 2 ** (2 * depth - 2);
}

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
    private readonly keyStride: number;

    constructor(
        private readonly P: Poseidon,
        readonly depth: number,
    ) {
        // keyStride · depth must stay within Number.MAX_SAFE_INTEGER:
        // 2·25−2 = 48 bits of index + 5 of level = 53.
        if (depth < 1 || depth > MAX_DEPTH) {
            throw new RangeError(`MerkleTree: depth must be 1..${MAX_DEPTH}, got ${depth}`);
        }
        this.keyStride = cacheKeyStride(depth);
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

    /**
     * Insert multiple leaves and evict only the minimal dirty range.
     * Use instead of repeated insert() when adding a contiguous block.
     */
    bulkInsert(leaves: Field[]): void {
        if (leaves.length === 0) return;
        const lo = this.leaves.length;
        for (const leaf of leaves) this.leaves.push(leaf);
        this.invalidateRange(lo, this.leaves.length - 1);
    }

    /**
     * Replace the whole leaf array. Clears the node cache, so this is safe
     * on a tree that already has inserts — the previous contract required
     * a freshly constructed tree but did not enforce it.
     */
    setLeaves(leaves: Field[]): void {
        this.leaves = [...leaves];
        this.nodeCache.clear();
    }

    root(): Field {
        return this.nodeAt(this.depth, 0);
    }

    /**
     * Frontier snapshot for the lazy-root tree-update circuit. Returns `depth × 3` slots.
     * For each level `lvl` and slot `k ∈ {0,1,2}`:
     *   frontier[lvl][k] = nodeAt(lvl, parentIdx * 4 + k)   if k < currentSlot
     *   frontier[lvl][k] = 0                                  otherwise
     * where `currentSlot = (N / 4^lvl) % 4`, `parentIdx = N / 4^(lvl+1)`, `N = leaves.length`.
     * k ≥ currentSlot entries are not read by the next insert; zeroed deterministically.
     */
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

    private cacheKey(level: number, index: number): number {
        return level * this.keyStride + index;
    }

    private hashNode(c0: Field, c1: Field, c2: Field, c3: Field): Field {
        return this.P.hash([TAG_MERKLE, c0, c1, c2, c3]);
    }
}
