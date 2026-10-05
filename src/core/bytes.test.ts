// Little-endian field <-> bytes, as properties, in both directions:
// field->bytes->field for codecs, bytes->field->bytes so a wire value survives
// a store and re-emit.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { bytesEqual, FIELD_BYTES, fromLeBytes, toLeBytes } from "./bytes.js";
import { BN254_FR } from "./field.js";

const field = fc.bigInt({ min: 0n, max: BN254_FR - 1n });

describe("little-endian field bytes", () => {
    it("round-trips any canonical field element", () => {
        fc.assert(
            fc.property(field, (f) => {
                expect(fromLeBytes(toLeBytes(f))).toBe(f);
            }),
        );
    });

    it("is fixed width", () => {
        fc.assert(
            fc.property(field, (f) => {
                expect(toLeBytes(f)).toHaveLength(FIELD_BYTES);
            }),
        );
    });

    it("round-trips any byte string of field width", () => {
        fc.assert(
            fc.property(fc.uint8Array({ minLength: FIELD_BYTES, maxLength: FIELD_BYTES }), (b) => {
                expect(toLeBytes(fromLeBytes(b))).toEqual(b);
            }),
        );
    });
});

describe("bytesEqual", () => {
    it("holds for a byte string and its copy", () => {
        fc.assert(
            fc.property(fc.uint8Array({ maxLength: 64 }), (b) => {
                expect(bytesEqual(b, b.slice())).toBe(true);
            }),
        );
    });

    it("fails when any one byte differs", () => {
        fc.assert(
            fc.property(fc.uint8Array({ minLength: 1, maxLength: 64 }), fc.nat(), (b, at) => {
                const other = b.slice();
                other[at % b.length]! ^= 1;
                expect(bytesEqual(b, other)).toBe(false);
            }),
        );
    });

    it("fails for a prefix of the other", () => {
        const b = Uint8Array.of(1, 2, 3);
        expect(bytesEqual(b, b.subarray(0, 2))).toBe(false);
        expect(bytesEqual(b.subarray(0, 2), b)).toBe(false);
        expect(bytesEqual(new Uint8Array(0), new Uint8Array(0))).toBe(true);
    });
});
