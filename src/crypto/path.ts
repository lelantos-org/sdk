// Merkle path recomputation — the verification counterpart to
// `MerkleTree.proof()`.
//
// A second, independent implementation of the same quaternary node hashing as
// `merkle.ts`: one builds, one checks. `path.test.ts` cross-validates the two,
// since a divergence would let the wallet prove membership against a root the
// chain never held.

import type { Field, Poseidon } from "./poseidon.js";
import { TAG_MERKLE } from "./tags.js";

const ARITY = 4;

/** Recompute the root a `(leaf, path)` pair attests to. */
export function rootFromPath(
    P: Poseidon,
    leaf: Field,
    pathElements: Field[][],
    pathIndices: number[],
): Field {
    let cur: Field = leaf;
    for (let lvl = 0; lvl < pathIndices.length; lvl++) {
        const slot = pathIndices[lvl];
        const sibs = pathElements[lvl] ?? [];
        const children: Field[] = [];
        let s = 0;
        for (let k = 0; k < ARITY; k++) {
            if (k === slot) children.push(cur);
            else children.push(sibs[s++] ?? 0n);
        }
        cur = P.hash([TAG_MERKLE, children[0]!, children[1]!, children[2]!, children[3]!]);
    }
    return cur;
}

/** Outcome of a path check. `computedRoot` is what the path actually hashes to. */
export interface PathCheck {
    ok: boolean;
    computedRoot: Field;
}

/**
 * Check a path against the set of roots the chain accepts. Returns the
 * computed root alongside the verdict so a rejection is diagnosable.
 */
export async function verifyPath(
    P: Poseidon,
    leaf: Field,
    pathElements: Field[][],
    pathIndices: number[],
    isKnownRootOnChain: (root: Field) => Promise<boolean>,
): Promise<PathCheck> {
    const computedRoot = rootFromPath(P, leaf, pathElements, pathIndices);
    return { ok: await isKnownRootOnChain(computedRoot), computedRoot };
}
