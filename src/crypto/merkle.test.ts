import { describe, expect, it } from "vitest";
import { cacheKeyStride, MerkleTree } from "./merkle.js";
import type { Field, Poseidon } from "./poseidon.js";
import { TAG_MERKLE } from "./tags.js";

// Deterministic stub — output depends only on inputs, never on call order.
const MOD = 2n ** 254n;
const stubP: Poseidon = {
    backend: "js",
    hash: (arr: Field[]) => arr.reduce((a, b) => (a * 1000003n + b) % MOD, 1n),
};

function makeTree(depth: number, leaves: Field[]): MerkleTree {
    const t = new MerkleTree(stubP, depth);
    for (const leaf of leaves) t.insert(leaf);
    return t;
}

/** Independent, cache-free root — the oracle for cache-correctness tests. */
function naiveRoot(depth: number, leaves: Field[]): Field {
    let level: Field[] = [...leaves];
    for (let d = 0; d < depth; d++) {
        const zero = zeroAt(d);
        const next: Field[] = [];
        for (let i = 0; i < Math.max(1, Math.ceil(level.length / 4)); i++) {
            next.push(
                stubP.hash([
                    TAG_MERKLE,
                    level[i * 4] ?? zero,
                    level[i * 4 + 1] ?? zero,
                    level[i * 4 + 2] ?? zero,
                    level[i * 4 + 3] ?? zero,
                ]),
            );
        }
        level = next;
    }
    return level[0]!;
}

function zeroAt(level: number): Field {
    let z: Field = 0n;
    for (let i = 0; i < level; i++) z = stubP.hash([TAG_MERKLE, z, z, z, z]);
    return z;
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

            const t1 = makeTree(4, [...initial, ...extra]);

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

    describe("node cache", () => {
        // The cache key packs (level, index) into one number. A stride too
        // small for the tree aliases one level's key onto another's and
        // silently corrupts the root.
        //
        // Asserted on the key arithmetic rather than through a real tree:
        // aliasing needs a level-1 index of at least the stride, which for a
        // depth-10 stride means >4^10 leaves — more than a unit test can
        // allocate. The assertion is the invariant, not a sample: the stride
        // must exceed every index reachable at any level, otherwise
        // `level * stride + index` for one level lands inside the next
        // level's range.
        it("stride exceeds the widest reachable index at every level", () => {
            for (const depth of [4, 10, 12, 20, 25]) {
                const stride = cacheKeyStride(depth);
                for (let level = 1; level <= depth; level++) {
                    // Cached nodes at `level` have index < 4^(depth-level).
                    expect(stride).toBeGreaterThanOrEqual(4 ** (depth - level));
                }
                // Widest key stays a safe integer.
                expect(Number.isSafeInteger(depth * stride + 4 ** (depth - 1))).toBe(true);
            }
        });

        it("a stride fixed at 2^18 would hold at depth 10 and alias above it", () => {
            const FIXED = 2 ** 18;
            // Depth 10: largest level-1 index is 4^9 - 1 = 2^18 - 1, which fits.
            expect(4 ** 9).toBe(FIXED);
            expect(cacheKeyStride(10)).toBe(FIXED);

            // Depth 11: level-1 indices run to 4^10 - 1, four times that
            // stride, so (1, 2^18) collides head-on with (2, 0).
            expect(4 ** 10).toBeGreaterThan(FIXED);
            expect(1 * FIXED + FIXED).toBe(2 * FIXED + 0);
            expect(cacheKeyStride(11)).toBeGreaterThanOrEqual(4 ** 10);
        });

        it("root matches a cache-free recomputation at depth 12", () => {
            const leaves = Array.from({ length: 40 }, (_, i) => BigInt(i + 1));
            const cached = new MerkleTree(stubP, 12);
            cached.bulkInsert(leaves);
            expect(cached.root()).toBe(naiveRoot(12, leaves));
        });

        it("setLeaves after inserts yields the same root as a fresh tree", () => {
            const first = [1n, 2n, 3n, 4n, 5n];
            const replacement = [90n, 91n, 92n];

            const reused = makeTree(4, first);
            reused.root(); // populate the cache with the pre-replacement tree
            reused.setLeaves(replacement);

            expect(reused.root()).toBe(makeTree(4, replacement).root());
        });

        it("rejects a depth whose cache key would exceed 2^53", () => {
            expect(() => new MerkleTree(stubP, 26)).toThrow(RangeError);
            expect(() => new MerkleTree(stubP, 0)).toThrow(RangeError);
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

describe("node cache export/import", () => {
    it("restores a tree without recomputing any node", () => {
        const leaves = Array.from({ length: 40 }, (_, i) => BigInt(i + 1));
        const source = makeTree(3, leaves);
        const want = source.root();
        const nodes = source.exportNodes();
        expect(nodes.length).toBeGreaterThan(0);

        // Counting Poseidon calls is the whole point: a restore that still
        // rebuilds would return the right root and look fine.
        let hashes = 0;
        const countingP: Poseidon = {
            backend: "js",
            hash: (arr: Field[]) => {
                hashes++;
                return stubP.hash(arr);
            },
        };
        const restored = new MerkleTree(countingP, 3);
        restored.setLeaves(leaves);
        // The constructor hashes the zero-ladder; only count from here.
        hashes = 0;
        restored.importNodes(nodes);

        expect(restored.root()).toBe(want);
        expect(hashes).toBe(0);
    });

    it("still yields the right root when nodes are not restored", () => {
        const leaves = Array.from({ length: 17 }, (_, i) => BigInt(i * 7 + 1));
        const source = makeTree(3, leaves);
        const fresh = new MerkleTree(stubP, 3);
        fresh.setLeaves(leaves);
        expect(fresh.root()).toBe(source.root());
    });

    it("refuses a node from a level the tree does not have", () => {
        // `(level, index)` is depth-independent, so nodes move between trees
        // freely — but a level this tree cannot represent would be cached
        // under a key it later reads back as a different level.
        const deep = makeTree(4, [1n, 2n, 3n, 4n]);
        deep.root(); // nodes are memoized lazily; nothing is cached before this
        const nodes = deep.exportNodes();
        expect(nodes.some((n) => n.level > 2)).toBe(true);

        const shallow = new MerkleTree(stubP, 2);
        expect(() => shallow.importNodes(nodes)).toThrow(RangeError);
    });

    it("keeps a restored tree correct across further inserts", () => {
        const leaves = Array.from({ length: 20 }, (_, i) => BigInt(i + 1));
        const source = makeTree(3, leaves);
        source.root();

        const restored = new MerkleTree(stubP, 3);
        restored.setLeaves(leaves);
        restored.importNodes(source.exportNodes());
        restored.insert(999n);
        source.insert(999n);

        // The restored cache must be invalidated by the insert just like a
        // natively-built one, or the new leaf is silently ignored.
        expect(restored.root()).toBe(source.root());
        expect(restored.root()).toBe(naiveRoot(3, [...leaves, 999n]));
    });
});
