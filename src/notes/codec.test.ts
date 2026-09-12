// The 112-byte note plaintext codec.
//
// Width is load-bearing: `decodeNotePayload` rejects any other length and the
// AEAD framing assumes this one. The round-trip is a property because the
// failure mode is a field offset slip.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BN254_FR, POW_2_64 } from "../core/field.js";
import {
    decodeNotePayload,
    encodeNotePayload,
    NOTE_PLAINTEXT_BYTES,
    type NotePayload,
} from "./codec.js";

const field = fc.bigInt({ min: 0n, max: BN254_FR - 1n });
/** `asset` and `value` are `u64` on the wire, not full field elements. */
const u64 = fc.bigInt({ min: 0n, max: POW_2_64 - 1n });

const notePayload: fc.Arbitrary<NotePayload> = fc.record({
    asset: u64,
    value: u64,
    rho: field,
    rcm: field,
    rcvDep: field,
});

describe("note plaintext codec", () => {
    it("round-trips any payload", () => {
        fc.assert(
            fc.property(notePayload, (p) => {
                expect(decodeNotePayload(encodeNotePayload(p))).toEqual(p);
            }),
        );
    });

    it("is fixed-width regardless of value", () => {
        fc.assert(
            fc.property(notePayload, (p) => {
                expect(encodeNotePayload(p)).toHaveLength(NOTE_PLAINTEXT_BYTES);
            }),
        );
    });

    it("rejects any other length", () => {
        expect(() => decodeNotePayload(new Uint8Array(NOTE_PLAINTEXT_BYTES - 1))).toThrow();
        expect(() => decodeNotePayload(new Uint8Array(NOTE_PLAINTEXT_BYTES + 1))).toThrow();
    });
});
