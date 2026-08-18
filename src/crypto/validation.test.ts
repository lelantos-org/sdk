import { beforeAll, describe, expect, it } from "vitest";
import { BN254_FR } from "../core/field.js";
import { fieldToBytes32 } from "../core/hex.js";
import { buildNoteCommitment } from "./commit.js";
import { MerkleTree } from "./merkle.js";
import { rootFromPath } from "./path.js";
import { Poseidon } from "./poseidon.js";

// Boundary checks on the field/point layer. The SDK validates carefully at the
// JSON boundary (`core/decode`, `core/brand`) but used to hand raw decoded
// values straight to field arithmetic, where the failures are silent.

describe("Poseidon canonical inputs", () => {
    let P: Poseidon;
    beforeAll(async () => {
        P = await Poseidon.build();
    });

    it("rejects an unreduced input rather than aliasing it", () => {
        // poseidon-lite reduces mod r internally, so `x` and `x + r` hashed
        // identically — two distinct merkle leaves or decoded note records
        // could be made to collide by construction.
        expect(() => P.hash([BN254_FR])).toThrow(/canonical field element/);
        expect(() => P.hash([1n, 2n + BN254_FR])).toThrow(/canonical field element/);
    });

    it("rejects a negative input", () => {
        expect(() => P.hash([-1n])).toThrow(/canonical field element/);
    });

    it("still accepts the full canonical range", () => {
        expect(() => P.hash([0n, BN254_FR - 1n])).not.toThrow();
    });

    it("rejects a negative asset or value in a note commitment", () => {
        const base = { pk: 1n, rho: 2n, rcm: 3n };
        expect(() => buildNoteCommitment(P, { ...base, asset: -1n, value: 1n })).toThrow(/asset/);
        expect(() => buildNoteCommitment(P, { ...base, asset: 1n, value: -1n })).toThrow(/value/);
    });
});

describe("fieldToBytes32", () => {
    it("refuses a negative, which would pad to a 64-char string containing a minus", () => {
        // `(-1n).toString(16)` is "-1"; padded it passes a length check and is
        // branded `Hex32` on the way into ABI encoding and persisted records.
        expect(() => fieldToBytes32(-1n)).toThrow(/32-byte unsigned integer/);
    });

    it("refuses a value wider than 32 bytes, where padStart is a no-op", () => {
        expect(() => fieldToBytes32(1n << 256n)).toThrow(/32-byte unsigned integer/);
    });

    it("accepts the exact boundary", () => {
        expect(fieldToBytes32((1n << 256n) - 1n)).toBe(`0x${"f".repeat(64)}`);
    });
});

describe("rootFromPath validation", () => {
    let P: Poseidon;
    beforeAll(async () => {
        P = await Poseidon.build();
    });

    const level = (): bigint[] => [7n, 8n, 9n];

    it("rejects an out-of-range slot instead of silently dropping the leaf", () => {
        // With slot 4 the `k === slot` branch never fired: the leaf was
        // discarded and the level hashed from siblings alone, returning a
        // plausible root for a leaf that was never in the tree.
        expect(() => rootFromPath(P, 1n, [level()], [4])).toThrow(/pathIndices/);
        expect(() => rootFromPath(P, 1n, [level()], [-1])).toThrow(/pathIndices/);
    });

    it("rejects a level with the wrong sibling count rather than zero-padding", () => {
        expect(() => rootFromPath(P, 1n, [[7n, 8n]], [0])).toThrow(/siblings/);
    });

    it("rejects mismatched path lengths", () => {
        expect(() => rootFromPath(P, 1n, [level(), level()], [0])).toThrow(/sibling levels/);
    });

    it("accepts a well-formed path", () => {
        expect(() => rootFromPath(P, 1n, [level()], [2])).not.toThrow();
    });
});

describe("MerkleTree bounds", () => {
    let P: Poseidon;
    beforeAll(async () => {
        P = await Poseidon.build();
    });

    it("rejects an imported node index that would alias into another level", () => {
        // The cache key is `level * keyStride + index`, so at depth 10 the node
        // {level: 1, index: 262144} is exactly the key for {level: 2, index: 0}
        // — served thereafter as an internal node covering leaves it knows
        // nothing about, and preserved across a save/load cycle.
        const tree = new MerkleTree(P, 10);
        const aliased = 4 ** (10 - 1);

        expect(() => tree.importNodes([{ level: 1, index: aliased, value: 42n }])).toThrow(
            RangeError,
        );
        expect(() => tree.importNodes([{ level: 1, index: -1, value: 42n }])).toThrow(RangeError);
        expect(() =>
            tree.importNodes([{ level: 1, index: aliased - 1, value: 42n }]),
        ).not.toThrow();
    });

    it("rejects a proof for a leaf that does not exist", () => {
        const tree = new MerkleTree(P, 4);
        tree.setLeaves([1n, 2n, 3n]);

        expect(() => tree.proof(-1)).toThrow(RangeError);
        expect(() => tree.proof(3)).toThrow(RangeError);
        expect(() => tree.proof(2)).not.toThrow();
    });
});
