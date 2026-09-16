import { beforeAll, describe, expect, it } from "vitest";
import { BN254_FR } from "../core/field.js";
import { fieldToBytes32 } from "../core/hex.js";
import { InvalidArgumentError } from "../errors/config.js";
import { buildNoteCommitment } from "./commit.js";
import { MerkleTree } from "./merkle.js";
import { rootFromPath } from "./path.js";
import { Poseidon } from "./poseidon.js";

// Boundary checks on the field/point layer. Validation at the JSON boundary
// (`services/http/decode`, `core/brand`) does not cover field arithmetic, where invalid
// values fail silently.

describe("Poseidon canonical inputs", () => {
    let P: Poseidon;
    beforeAll(async () => {
        P = await Poseidon.build();
    });

    it("rejects an unreduced input rather than aliasing it", () => {
        // poseidon-lite reduces mod r internally, so without the check `x` and `x + r` hash
        // identically and distinct merkle leaves or decoded note records could collide.
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
        // `(-1n).toString(16)` is "-1"; padded, it would pass a length check and be branded
        // `Hex32` for ABI encoding and persisted records.
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
        // With slot 4 the `k === slot` branch never fires: the leaf is discarded and the level
        // hashed from siblings alone, yielding a plausible root for a leaf not in the tree.
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
        // {level: 1, index: 262144} has the key for {level: 2, index: 0}; it would be served as
        // that internal node and persisted across a save/load cycle.
        const tree = new MerkleTree(P, 10);
        const aliased = 4 ** (10 - 1);

        expect(() => tree.importNodes([{ level: 1, index: aliased, value: 42n }])).toThrow(
            InvalidArgumentError,
        );
        expect(() => tree.importNodes([{ level: 1, index: -1, value: 42n }])).toThrow(
            InvalidArgumentError,
        );
        expect(() =>
            tree.importNodes([{ level: 1, index: aliased - 1, value: 42n }]),
        ).not.toThrow();
    });

    it("rejects a proof for a leaf that does not exist", () => {
        const tree = new MerkleTree(P, 4);
        tree.setLeaves([1n, 2n, 3n]);

        expect(() => tree.proof(-1)).toThrow(InvalidArgumentError);
        expect(() => tree.proof(3)).toThrow(InvalidArgumentError);
        expect(() => tree.proof(2)).not.toThrow();
    });
});
