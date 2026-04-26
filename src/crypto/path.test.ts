import { describe, expect, it } from "vitest";
import { MerkleTree } from "./merkle.js";
import { rootFromPath, verifyPath } from "./path.js";
import type { Field, Poseidon } from "./poseidon.js";

// Deterministic stub — output depends only on inputs, never on call order.
const MOD = 2n ** 254n;
const stubP: Poseidon = {
    hash: (arr: Field[]) => arr.reduce((a, b) => (a * 1000003n + b) % MOD, 1n),
};

function treeOf(depth: number, count: number): MerkleTree {
    const t = new MerkleTree(stubP, depth);
    t.bulkInsert(Array.from({ length: count }, (_, i) => BigInt(i + 1)));
    return t;
}

// `MerkleTree` builds paths, `rootFromPath` checks them. They are separate
// implementations of the same quaternary hashing, and nothing previously
// asserted they agree — a divergence would let the wallet prove membership
// against a root the chain never held.
describe("rootFromPath vs MerkleTree.proof", () => {
    for (const depth of [2, 3, 10]) {
        it(`agrees at depth ${depth} for every leaf`, () => {
            const count = depth === 10 ? 37 : 4 ** depth - 1;
            const tree = treeOf(depth, count);
            const root = tree.root();

            for (let i = 0; i < count; i++) {
                const { pathElements, pathIndices } = tree.proof(i);
                expect(rootFromPath(stubP, tree.leaves[i], pathElements, pathIndices)).toBe(root);
            }
        });
    }

    it("rejects a tampered sibling", () => {
        const tree = treeOf(4, 12);
        const { pathElements, pathIndices } = tree.proof(5);
        pathElements[0][0] = pathElements[0][0] + 1n;
        expect(rootFromPath(stubP, tree.leaves[5], pathElements, pathIndices)).not.toBe(
            tree.root(),
        );
    });

    it("rejects a tampered leaf", () => {
        const tree = treeOf(4, 12);
        const { pathElements, pathIndices } = tree.proof(5);
        expect(rootFromPath(stubP, 999_999n, pathElements, pathIndices)).not.toBe(tree.root());
    });
});

describe("verifyPath", () => {
    it("returns the computed root alongside the verdict", async () => {
        const tree = treeOf(4, 12);
        const { pathElements, pathIndices } = tree.proof(3);

        const accepted = await verifyPath(
            stubP,
            tree.leaves[3],
            pathElements,
            pathIndices,
            async (r) => r === tree.root(),
        );
        expect(accepted).toEqual({ ok: true, computedRoot: tree.root() });

        const rejected = await verifyPath(
            stubP,
            tree.leaves[3],
            pathElements,
            pathIndices,
            async () => false,
        );
        // Even on rejection the caller learns what the path hashed to, which
        // is the difference between "unknown root" and "corrupt path".
        expect(rejected).toEqual({ ok: false, computedRoot: tree.root() });
    });
});
