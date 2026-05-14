// Quaternary sparse Merkle tree, Poseidon-arity-5 nodes:
//   node = Poseidon(TAG_MERKLE, c0, c1, c2, c3)
// Mirrors `circuits/src/lib/merkle.circom`.

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
    }

    insert(leaf: Field): number {
        return this.leaves.push(leaf) - 1;
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
            const stride = ARITY ** lvl;
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
        const subtreeStart = index * ARITY ** level;
        if (subtreeStart >= this.leaves.length) return this.zeros[level];

        const childLevel = level - 1;
        const firstChild = index * ARITY;
        return this.hashNode(
            this.nodeAt(childLevel, firstChild),
            this.nodeAt(childLevel, firstChild + 1),
            this.nodeAt(childLevel, firstChild + 2),
            this.nodeAt(childLevel, firstChild + 3),
        );
    }

    private hashNode(c0: Field, c1: Field, c2: Field, c3: Field): Field {
        return this.P.hash([TAG_MERKLE, c0, c1, c2, c3]);
    }
}
