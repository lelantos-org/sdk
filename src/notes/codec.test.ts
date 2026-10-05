// The 96-byte note plaintext codec.
//
// Width is load-bearing: `decodeNotePayload` rejects any other length and the
// AEAD framing assumes this one. The round-trip is property-tested to catch
// field offset errors.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BN254_FR, POW_2_64 } from "../core/field.js";
import { DIVERSIFIER_BOUND } from "../crypto/diversified-base.js";
import {
    decodeNotePayload,
    encodeNotePayload,
    NOTE_CIPHERTEXT_BYTES,
    NOTE_PLAINTEXT_BYTES,
    type NotePayload,
} from "./codec.js";

const field = fc.bigInt({ min: 0n, max: BN254_FR - 1n });
/** `asset` and `value` are `u64` on the wire, not full field elements. */
const u64 = fc.bigInt({ min: 0n, max: POW_2_64 - 1n });
const seed = fc.uint8Array({ minLength: 32, maxLength: 32 });
const diversifier = fc.bigInt({ min: 0n, max: DIVERSIFIER_BOUND - 1n });

const notePayload: fc.Arbitrary<NotePayload> = fc.record({
    asset: u64,
    value: u64,
    rho: field,
    rseed: seed,
    d: diversifier,
});

const KNOWN: NotePayload = {
    asset: 0x0102030405060708n,
    value: 0x1112131415161718n,
    rho: (0x21n << 200n) | 0x22n,
    rseed: Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i),
    d: (0xd1n << 120n) | 0xd2n,
};

describe("note plaintext codec", () => {
    it("is 96 bytes", () => {
        expect(NOTE_PLAINTEXT_BYTES).toBe(96);
    });

    it("travels in a 114-byte wire ciphertext", () => {
        expect(NOTE_CIPHERTEXT_BYTES).toBe(114);
    });

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
        const hex = Buffer.from(encodeNotePayload(KNOWN)).toString("hex");
        expect(hex).toBe(
            "0807060504030201" +
                "1817161514131211" +
                `22${"00".repeat(24)}21${"00".repeat(6)}` +
                "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f" +
                `d2${"00".repeat(14)}d1`,
        );
        expect(decodeNotePayload(encodeNotePayload(KNOWN))).toEqual(KNOWN);
    });

    it("rejects any other length", () => {
        // 80 is the plaintext without its last 16 bytes: a note that names no diversifier.
        for (const length of [0, 80, NOTE_PLAINTEXT_BYTES - 1, NOTE_PLAINTEXT_BYTES + 1, 112]) {
            expect(() => decodeNotePayload(new Uint8Array(length))).toThrow(/expected 96B/);
        }
    });

    it("refuses to encode a field wider than its slot", () => {
        const encode = (over: Partial<NotePayload>) => () =>
            encodeNotePayload({ ...KNOWN, ...over });

        expect(encode({ asset: POW_2_64 })).toThrow();
        expect(encode({ value: POW_2_64 })).toThrow();
        expect(encode({ rho: 1n << 256n })).toThrow();
        expect(encode({ d: DIVERSIFIER_BOUND })).toThrow();
        expect(encode({ rseed: new Uint8Array(31) })).toThrow(/rseed/);
        expect(encode({ rseed: new Uint8Array(33) })).toThrow(/rseed/);
    });

    it("decodes the seed as a copy of the plaintext bytes", () => {
        // The plaintext buffer is the decryptor's; a view would alias it.
        const buf = encodeNotePayload(KNOWN);
        const { rseed } = decodeNotePayload(buf);
        buf.fill(0);
        expect(rseed).toEqual(KNOWN.rseed);
    });
});
