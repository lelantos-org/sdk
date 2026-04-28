// Wallet-side tree sync helpers.
//
// In the lazy-root model the chain holds only `roots[ring]` + `isKnownRoot`
// + `committedCount`. The actual leaves and merkle paths live with the
// relayer. Wallets verify any path the relayer hands them by recomputing
// the root from `(leaf, pathElements, pathIndices)` and asserting the
// result is on-chain `isKnownRoot`. Soundness gives no path-forgery vector.

import type { Poseidon, Field } from "./crypto/index";
import { TAG_MERKLE } from "./crypto/index";

const ARITY = 4;

/// Recompute the merkle root from a path supplied by the relayer.
export function rootFromPath(
    P: Poseidon,
    leaf: Field,
    pathElements: Field[][],
    pathIndices: number[],
): Field {
    let cur: Field = leaf;
    for (let lvl = 0; lvl < pathIndices.length; lvl++) {
        const slot = pathIndices[lvl];
        const sibs = pathElements[lvl];
        const children: Field[] = [];
        let s = 0;
        for (let k = 0; k < ARITY; k++) {
            if (k === slot) children.push(cur);
            else children.push(sibs[s++]);
        }
        cur = P.hash([TAG_MERKLE, children[0], children[1], children[2], children[3]]);
    }
    return cur;
}

/// Verify a relayer-supplied merkle path against an on-chain root oracle.
/// Caller passes a `isKnownRootOnChain(root)` predicate (e.g. an
/// ethers-contract `isKnownRoot(bytes32)` view call).
export async function verifyPath(
    P: Poseidon,
    leaf: Field,
    pathElements: Field[][],
    pathIndices: number[],
    isKnownRootOnChain: (root: Field) => Promise<boolean>,
): Promise<boolean> {
    const root = rootFromPath(P, leaf, pathElements, pathIndices);
    return isKnownRootOnChain(root);
}
