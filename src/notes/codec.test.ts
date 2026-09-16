// The 112-byte note plaintext codec.
//
// Width is load-bearing: `decodeNotePayload` rejects any other length and the
// AEAD framing assumes this one. The round-trip is property-tested to catch
// field offset errors.

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

    it("pins the wire layout to a known answer", () => {
        const p: NotePayload = {
            asset: 0x0102030405060708n,
            value: 0x1112131415161718n,
            rho: (0x21n << 200n) | 0x22n,
            rcm: (1n << 250n) + 0x33n,
            rcvDep: 0x44n,
        };
        const hex = Buffer.from(encodeNotePayload(p)).toString("hex");
        expect(hex).toBe(
            "0807060504030201" +
                "1817161514131211" +
                `22${"00".repeat(24)}21${"00".repeat(6)}` +
                `33${"00".repeat(30)}04` +
                `44${"00".repeat(31)}`,
        );
        expect(decodeNotePayload(encodeNotePayload(p))).toEqual(p);
    });

    it("rejects any other length", () => {
        expect(() => decodeNotePayload(new Uint8Array(NOTE_PLAINTEXT_BYTES - 1))).toThrow();
        expect(() => decodeNotePayload(new Uint8Array(NOTE_PLAINTEXT_BYTES + 1))).toThrow();
    });
});
