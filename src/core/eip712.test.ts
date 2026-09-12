// Unit tests for the narrow EIP-712 encoder.
//
// `src/encoding-parity.test.ts` pins the digest for the SDK's own schema
// against an ethers@6 constant. These cover that every input reaches the
// output.

import { describe, expect, it } from "vitest";
import { hashStringStruct, typedDataDigest } from "./eip712.js";

const DOMAIN = "EIP712Domain(string name,string version)";

describe("hashStringStruct", () => {
    it("is 32 bytes", () => {
        expect(hashStringStruct(DOMAIN, ["Lelantos", "2"])).toHaveLength(32);
    });

    it("depends on every value", () => {
        const base = hashStringStruct(DOMAIN, ["Lelantos", "2"]);
        expect(hashStringStruct(DOMAIN, ["Lelantos", "3"])).not.toEqual(base);
        expect(hashStringStruct(DOMAIN, ["Lelantos!", "2"])).not.toEqual(base);
    });

    it("depends on the type string", () => {
        // The type string binds a struct's shape into its hash: two schemas
        // sharing values must not share a digest.
        expect(hashStringStruct(DOMAIN, ["a", "b"])).not.toEqual(
            hashStringStruct("Other(string x,string y)", ["a", "b"]),
        );
    });

    it("does not confuse field boundaries", () => {
        // Members are hashed then concatenated, so moving a character across a
        // boundary must change the result.
        expect(hashStringStruct(DOMAIN, ["ab", "c"])).not.toEqual(
            hashStringStruct(DOMAIN, ["a", "bc"]),
        );
    });
});

describe("typedDataDigest", () => {
    const a = hashStringStruct(DOMAIN, ["Lelantos", "2"]);
    const b = hashStringStruct("Msg(string purpose,string version)", ["nsk-derivation", "2"]);

    it("returns 0x-prefixed 32 bytes", () => {
        expect(typedDataDigest(a, b)).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("depends on both halves, and on their order", () => {
        expect(typedDataDigest(a, b)).not.toBe(typedDataDigest(b, a));
        expect(typedDataDigest(a, b)).not.toBe(typedDataDigest(a, a));
    });

    it("is deterministic", () => {
        expect(typedDataDigest(a, b)).toBe(typedDataDigest(a, b));
    });
});
