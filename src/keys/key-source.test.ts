import { describe, expect, it } from "vitest";
import { BN254_FR } from "../core/field.js";
import { resolveNsk } from "./key-source.js";

describe("resolveNsk", () => {
    it("rejects a raw nsk of zero, which makes pk_d the identity", () => {
        // `nsk = 0` gives `pk_d = 0 · Base8 = O`; a note encrypted to the
        // identity is decryptable by anyone who sees the ephemeral key.
        expect(() => resolveNsk({ type: "nsk", nsk: 0n })).toThrow(/nsk must be/);
    });

    it("rejects an unreduced raw nsk instead of aliasing it to another wallet", () => {
        expect(() => resolveNsk({ type: "nsk", nsk: BN254_FR + 5n })).toThrow(/nsk must be/);
        expect(() => resolveNsk({ type: "nsk", nsk: BN254_FR })).toThrow(/nsk must be/);
    });

    it("accepts a canonical nsk", () => {
        expect(resolveNsk({ type: "nsk", nsk: 5n })).toBe(5n);
        expect(resolveNsk({ type: "nsk", nsk: BN254_FR - 1n })).toBe(BN254_FR - 1n);
    });
});
