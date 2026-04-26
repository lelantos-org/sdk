// Quaternary sparse Merkle tree, Poseidon-arity-5 nodes:
//   node = Poseidon(TAG_MERKLE, c0, c1, c2, c3)
// Mirrors `circuits/src/lib/merkle.circom`.

import type { Poseidon, Field } from "./poseidon";
import { TAG_MERKLE } from "./tags";

const ARITY = 4;

export interface MerkleProof {
    pathElements: Field[][];
    pathIndices: number[];
}

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
