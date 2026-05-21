import { describe, expect, it } from "vitest";
import { MerkleTree } from "./merkle.js";
import type { Field, Poseidon } from "./poseidon.js";

// Deterministic stub — output depends only on inputs, never on call order.
const MOD = 2n ** 254n;
const stubP: Poseidon = {
    hash: (arr: Field[]) => arr.reduce((a, b) => (a * 1000003n + b) % MOD, 1n),
};

function makeTree(depth: number, leaves: Field[]): MerkleTree {
    const t = new MerkleTree(stubP, depth);
    for (const leaf of leaves) t.insert(leaf);
    return t;
}

describe("MerkleTree", () => {
    describe("insert vs bulkInsert parity", () => {
        it("empty tree root matches", () => {
            const t1 = new MerkleTree(stubP, 4);
            const t2 = new MerkleTree(stubP, 4);
            expect(t1.root()).toBe(t2.root());
        });

        it("single leaf", () => {
            const t1 = makeTree(4, [42n]);
            const t2 = new MerkleTree(stubP, 4);
            t2.bulkInsert([42n]);
            expect(t1.root()).toBe(t2.root());
        });

        it("partial chunk (< CHUNK_SIZE) leaves", () => {
            const leaves = Array.from({ length: 7 }, (_, i) => BigInt(i + 1));
            const t1 = makeTree(4, leaves);
            const t2 = new MerkleTree(stubP, 4);
            t2.bulkInsert(leaves);
            expect(t1.root()).toBe(t2.root());
        });

        it("full quaternary level (16 leaves)", () => {
            const leaves = Array.from({ length: 16 }, (_, i) => BigInt(i + 100));
            const t1 = makeTree(4, leaves);
            const t2 = new MerkleTree(stubP, 4);
            t2.bulkInsert(leaves);
            expect(t1.root()).toBe(t2.root());
        });

        it("proof pathElements and pathIndices match after bulkInsert", () => {
            const leaves = Array.from({ length: 8 }, (_, i) => BigInt(i + 1));
            const t1 = makeTree(4, leaves);
            const t2 = new MerkleTree(stubP, 4);
            t2.bulkInsert(leaves);
            for (let i = 0; i < leaves.length; i++) {
                const p1 = t1.proof(i);
                const p2 = t2.proof(i);
                expect(p1.pathIndices).toEqual(p2.pathIndices);
                expect(p1.pathElements).toEqual(p2.pathElements);
            }
        });
    });

    describe("setLeaves parity", () => {
        it("root matches insert after setLeaves", () => {
            const leaves = Array.from({ length: 12 }, (_, i) => BigInt(i + 1));
            const t1 = makeTree(4, leaves);
            const t2 = new MerkleTree(stubP, 4);
            t2.setLeaves(leaves);
            expect(t1.root()).toBe(t2.root());
        });

        it("proof matches insert after setLeaves", () => {
            const leaves = Array.from({ length: 12 }, (_, i) => BigInt(i + 1));
            const t1 = makeTree(4, leaves);
            const t2 = new MerkleTree(stubP, 4);
            t2.setLeaves(leaves);
            for (let i = 0; i < leaves.length; i++) {
                expect(t1.proof(i)).toEqual(t2.proof(i));
            }
        });
    });

    describe("cache invalidation correctness", () => {
        it("root updates after insert on cached tree", () => {
            const leaves = Array.from({ length: 8 }, (_, i) => BigInt(i + 1));
            const t = new MerkleTree(stubP, 4);
            t.setLeaves(leaves);
            const before = t.root();
            t.insert(999n);
            expect(t.root()).not.toBe(before);
        });

        it("root updates after bulkInsert on cached tree", () => {
            const leaves = Array.from({ length: 8 }, (_, i) => BigInt(i + 1));
            const t = new MerkleTree(stubP, 4);
            t.setLeaves(leaves);
            const before = t.root();
            t.bulkInsert([100n, 200n]);
            expect(t.root()).not.toBe(before);
        });

        it("incremental inserts after setLeaves match fresh inserts", () => {
            const initial = Array.from({ length: 8 }, (_, i) => BigInt(i + 1));
            const extra = [100n, 200n, 300n];

            // fresh tree, all inserts
            const t1 = makeTree(4, [...initial, ...extra]);

            // setLeaves then insert
            const t2 = new MerkleTree(stubP, 4);
            t2.setLeaves(initial);
            for (const leaf of extra) t2.insert(leaf);

            expect(t1.root()).toBe(t2.root());
            for (let i = 0; i < initial.length + extra.length; i++) {
                expect(t1.proof(i)).toEqual(t2.proof(i));
            }
        });

        it("incremental bulkInserts match fresh insert", () => {
            const a = Array.from({ length: 5 }, (_, i) => BigInt(i + 1));
            const b = Array.from({ length: 5 }, (_, i) => BigInt(i + 100));

            const t1 = makeTree(4, [...a, ...b]);

            const t2 = new MerkleTree(stubP, 4);
            t2.bulkInsert(a);
            t2.bulkInsert(b);

            expect(t1.root()).toBe(t2.root());
        });
    });

    describe("frontier", () => {
        it("frontier length equals depth", () => {
            const t = makeTree(4, [1n, 2n, 3n]);
            expect(t.frontier().length).toBe(4);
        });

        it("frontier consistent between insert and bulkInsert", () => {
            const leaves = [10n, 20n, 30n, 40n, 50n];
            const t1 = makeTree(4, leaves);
            const t2 = new MerkleTree(stubP, 4);
            t2.bulkInsert(leaves);
            expect(t1.frontier()).toEqual(t2.frontier());
        });
    });
});
