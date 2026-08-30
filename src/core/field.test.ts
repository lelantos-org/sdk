import { describe, expect, it } from "vitest";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR, REDUCE_SPARE_BITS, reduceWideToField } from "./field.js";

const bytes = (n: number, fill = 0xff): Uint8Array => new Uint8Array(n).fill(fill);

describe("reduceWideToField", () => {
    // The guard is the point of the function. Folding a bare 32-byte hash into
    // BN254 Fr leaves 2 spare bits and skews the low residues by ~6:5, which is
    // what the v1 key derivation did; it must be impossible to do accidentally.
    it("refuses a draw that is too narrow to reduce without bias", () => {
        expect(() => reduceWideToField(bytes(32), BN254_FR, "nsk")).toThrow(/spare bits/);
        expect(() => reduceWideToField(bytes(32), BABYJUB_SUBGROUP_ORDER, "nsk")).toThrow(
            /spare bits/,
        );
    });

    it("accepts a draw with the required margin", () => {
        // 40 bytes = 320 bits, 66 spare over BN254 Fr's 254.
        expect(() => reduceWideToField(bytes(40), BN254_FR, "nsk")).not.toThrow();
        expect(() => reduceWideToField(bytes(64), BABYJUB_SUBGROUP_ORDER, "nsk")).not.toThrow();
    });

    it("pins the margin at the documented width", () => {
        const frBits = BN254_FR.toString(2).length;
        const exact = Math.ceil((frBits + REDUCE_SPARE_BITS) / 8);
        expect(() => reduceWideToField(bytes(exact), BN254_FR, "nsk")).not.toThrow();
        expect(() => reduceWideToField(bytes(exact - 1), BN254_FR, "nsk")).toThrow(/spare bits/);
    });

    it("lands in [1, modulus) and is big-endian", () => {
        const v = reduceWideToField(bytes(40, 0x00), BN254_FR, "nsk");
        // All-zero input reduces to 0, which is remapped to 1 rather than left
        // as an identity ECDH key.
        expect(v).toBe(1n);

        const one = new Uint8Array(40);
        one[39] = 7;
        expect(reduceWideToField(one, BN254_FR, "nsk")).toBe(7n);

        const max = reduceWideToField(bytes(40, 0xff), BN254_FR, "nsk");
        expect(max).toBeGreaterThan(0n);
        expect(max).toBeLessThan(BN254_FR);
    });

    it("is a pure function of its input", () => {
        const b = bytes(40, 0x5a);
        expect(reduceWideToField(b, BN254_FR, "nsk")).toBe(reduceWideToField(b, BN254_FR, "nsk"));
    });
});
