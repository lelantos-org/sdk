// Little-endian field <-> bytes, as properties.
//
// Both directions are asserted: field->bytes->field for codecs,
// bytes->field->bytes so a wire value survives a store and re-emit.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { FIELD_BYTES, fromLeBytes, toLeBytes } from "./bytes.js";
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
