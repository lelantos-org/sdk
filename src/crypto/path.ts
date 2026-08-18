// Merkle path recomputation — the verification counterpart to
// `MerkleTree.proof()`.
//
// A second, independent implementation of the same quaternary node hashing as
// `merkle.ts`: one builds, one checks. `path.test.ts` cross-validates the two,
// since a divergence would let the wallet prove membership against a root the
// chain never held.

import { InvalidArgumentError } from "../core/errors.js";
import type { Field, Poseidon } from "./poseidon.js";
import { TAG_MERKLE } from "./tags.js";

const ARITY = 4;

/**
 * Recompute the root a `(leaf, path)` pair attests to.
 *
 * The path is validated rather than coerced. This is public API reached with
 * relayer-supplied data by design, and an out-of-range `pathIndices[lvl]` used
 * to mean the `k === slot` branch never fired: the running hash was dropped
 * entirely and the level hashed from siblings alone, returning a
 * plausible-looking root for a leaf that was never in the tree. A short
 * sibling array was zero-padded to the same effect.
 */
export function rootFromPath(
    P: Poseidon,
    leaf: Field,
    pathElements: Field[][],
    pathIndices: number[],
): Field {
    if (pathElements.length !== pathIndices.length) {
        throw new InvalidArgumentError(
            `rootFromPath: ${pathElements.length} sibling levels for ` +
                `${pathIndices.length} indices`,
        );
    }

    let cur: Field = leaf;
    for (let lvl = 0; lvl < pathIndices.length; lvl++) {
        const slot = pathIndices[lvl]!;
        if (!Number.isInteger(slot) || slot < 0 || slot >= ARITY) {
            throw new InvalidArgumentError(
                `rootFromPath: pathIndices[${lvl}] is ${slot}, expected 0..${ARITY - 1}`,
            );
        }
        const sibs = pathElements[lvl]!;
        if (sibs.length !== ARITY - 1) {
            throw new InvalidArgumentError(
                `rootFromPath: pathElements[${lvl}] has ${sibs.length} siblings, ` +
                    `expected ${ARITY - 1}`,
            );
        }

        const children: Field[] = [];
        let s = 0;
        for (let k = 0; k < ARITY; k++) {
            if (k === slot) children.push(cur);
            else children.push(sibs[s++]!);
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
