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
 * The stride must therefore track `depth`: a fixed value sized for one depth
 * lets a level-1 index of a deeper tree run past it and collide with a
 * level-2 key.
 *
 * @internal exported for the injectivity test; not part of the public API.
 */
export function cacheKeyStride(depth: number): number {
    return 2 ** (2 * depth - 2);
}

/**
 * A memoized internal node, addressed the way the tree thinks about it.
 *
 * Deliberately not the packed `nodeCache` key: that encoding depends on
 * `cacheKeyStride(depth)`, and anything persisting nodes would have to
 * reimplement it to unpack them. `(level, index)` also means the same subtree
 * in any tree containing those leaves, so a snapshot stays meaningful even if
 * the configured depth changes.
 *
 * @internal
 */
export interface MerkleNode {
    /** 1-based; level 0 is the leaves, which are stored separately. */
    level: number;
    index: number;
    value: Field;
}

/** @internal */
export interface MerkleProof {
    pathElements: Field[][];
    pathIndices: number[];
}

/** @internal */
export class MerkleTree {
    /**
     * Private backing store with a read-only view below.
     *
     * Every mutation path here evicts the dirty range from the node cache, so
     * a public mutable array let `tree.leaves.push(x)` from outside change the
     * tree without invalidating anything — leaving `root()` returning the
     * pre-mutation root.
     */
    private _leaves: Field[] = [];

    /** Leaves in insertion order. Mutate through `insert` / `setLeaves`. */
    get leaves(): readonly Field[] {
        return this._leaves;
    }
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
        const idx = this._leaves.push(leaf) - 1;
        this.invalidatePath(idx);
        return idx;
    }

    /**
     * Insert multiple leaves and evict only the minimal dirty range.
     * Use instead of repeated insert() when adding a contiguous block.
     */
    bulkInsert(leaves: Field[]): void {
        if (leaves.length === 0) return;
        const lo = this._leaves.length;
        for (const leaf of leaves) this._leaves.push(leaf);
        this.invalidateRange(lo, this._leaves.length - 1);
    }

    /**
     * Replace the whole leaf array. Clears the node cache, so this is safe
     * on a tree that already holds inserts.
     */
    setLeaves(leaves: Field[]): void {
        this._leaves = [...leaves];
        this.nodeCache.clear();
    }

    /**
     * Memoized internal nodes, for persistence.
     *
     * Restoring these is what lets a reloaded tree skip rebuilding: without
     * them the first `root()` or `getPath()` recomputes every internal node
     * from the leaves — ~350K Poseidon-5 hashes on a full tree, on every
     * single app open rather than only the first.
     */
    exportNodes(): MerkleNode[] {
        const out: MerkleNode[] = [];
        for (const [key, value] of this.nodeCache) {
            const level = Math.floor(key / this.keyStride);
            out.push({ level, index: key - level * this.keyStride, value });
        }
        return out;
    }

    /**
     * Reload previously exported nodes. Call *after* `setLeaves`, which
     * clears the cache.
     *
     * A level outside `1..depth` cannot have come from a tree this one can
     * represent, and caching it under a key this tree would later read as a
     * different level is exactly how a wrong root gets produced silently, so
     * it is rejected rather than skipped.
     */
    importNodes(nodes: Iterable<MerkleNode>): void {
        for (const { level, index, value } of nodes) {
            if (level < 1 || level > this.depth) {
                throw new RangeError(
                    `MerkleTree.importNodes: level ${level} outside 1..${this.depth}`,
                );
            }
            // `index` needs the same rejection as `level`, for the same reason.
            // The cache key is `level * keyStride + index`, so an index at or
            // past `keyStride` aliases into the next level: at the deployed
            // depth 10, `{level: 1, index: 262144}` is exactly the key for
            // `{level: 2, index: 0}`. The node is then served as an internal
            // node covering leaves it knows nothing about, `root()` and every
            // `proof()` describe a tree the chain never held, and
            // `exportNodes()` reads it back at the aliased position — so the
            // corruption survives a save/load cycle.
            const width = ARITY ** (this.depth - level);
            if (!Number.isInteger(index) || index < 0 || index >= width) {
                throw new RangeError(
                    `MerkleTree.importNodes: index ${index} outside 0..${width - 1} ` +
                        `at level ${level}`,
                );
            }
            this.nodeCache.set(this.cacheKey(level, index), value);
        }
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
        const N = this._leaves.length;
        const out: Field[][] = [];
        for (let lvl = 0; lvl < this.depth; lvl++) {
            const stride = this.strides[lvl]!;
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
        // Bounded: `proof(-1)` walks negative indices, falls through every
        // `?? 0n` / zeros lookup and returns a well-formed proof for a leaf
        // that does not exist.
        if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= this._leaves.length) {
            throw new RangeError(
                `MerkleTree.proof: leafIndex ${leafIndex} outside ` +
                    `0..${this._leaves.length - 1}`,
            );
        }
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
        if (level === 0) return this._leaves[index] ?? 0n;
        if (index * this.strides[level]! >= this._leaves.length) return this.zeros[level]!;

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
