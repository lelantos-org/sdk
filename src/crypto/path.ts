// Merkle path recomputation, the verification counterpart to `MerkleTree.proof()`.
//
// An independent implementation of the quaternary node hashing in `merkle.ts`. `path.test.ts`
// cross-validates the two, since a divergence would let the wallet prove membership against a
// root the chain never held.

import { InvalidArgumentError } from "../errors/config.js";
import type { Field, Poseidon } from "./poseidon.js";
import { TAG_MERKLE } from "./tags.js";

const ARITY = 4;

/**
 * Recompute the root a `(leaf, path)` pair attests to.
 *
 * The path is validated rather than coerced because it is relayer-supplied. An out-of-range
 * `pathIndices[lvl]` would skip the `k === slot` branch and hash the level from siblings alone,
 * yielding a plausible root for a leaf not in the tree. A short sibling array has the same effect.
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
            { argument: "pathElements" },
        );
    }

    let cur: Field = leaf;
    for (let lvl = 0; lvl < pathIndices.length; lvl++) {
        const slot = pathIndices[lvl]!;
        if (!Number.isInteger(slot) || slot < 0 || slot >= ARITY) {
            throw new InvalidArgumentError(
                `rootFromPath: pathIndices[${lvl}] is ${slot}, expected 0..${ARITY - 1}`,
                { argument: "pathIndices" },
            );
        }
        const sibs = pathElements[lvl]!;
        if (sibs.length !== ARITY - 1) {
            throw new InvalidArgumentError(
                `rootFromPath: pathElements[${lvl}] has ${sibs.length} siblings, ` +
                    `expected ${ARITY - 1}`,
                { argument: "pathElements" },
            );
        }

        const children = [...sibs];
        children.splice(slot, 0, cur);
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
 * Whether the pool would accept a proof against `root`.
 *
 * Shared contract: this module uses it for a scanned path, `TreeStore` before discarding a locally
 * built tree, and `ChainAdapter` supplies it.
 */
export type IsKnownRoot = (root: Field) => Promise<boolean>;

/**
 * Check a path against the set of roots the chain accepts. Returns the
 * computed root alongside the verdict so a rejection is diagnosable.
 */
export async function verifyPath(
    P: Poseidon,
    leaf: Field,
    pathElements: Field[][],
    pathIndices: number[],
    isKnownRootOnChain: IsKnownRoot,
): Promise<PathCheck> {
    const computedRoot = rootFromPath(P, leaf, pathElements, pathIndices);
    return { ok: await isKnownRootOnChain(computedRoot), computedRoot };
}
