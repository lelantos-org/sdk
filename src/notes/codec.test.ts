// The 224-byte note plaintext codec.
//
// Width is load-bearing: `decodeNotePayload` rejects any other length and the
// AEAD framing assumes this one. The round-trip is property-tested to catch
// field offset errors.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BN254_FR, POW_2_64 } from "../core/field.js";
import { DIVERSIFIER_BOUND } from "../crypto/diversified-base.js";
import {
    decodeMemo,
    decodeNotePayload,
    EMPTY_MEMO,
    encodeMemo,
    encodeNotePayload,
    MEMO_BYTES,
    NOTE_CIPHERTEXT_BYTES,
    NOTE_PLAINTEXT_BYTES,
    type NotePayload,
} from "./codec.js";

const field = fc.bigInt({ min: 0n, max: BN254_FR - 1n });
/** `asset` and `value` are `u64` on the wire, not full field elements. */
const u64 = fc.bigInt({ min: 0n, max: POW_2_64 - 1n });
const seed = fc.uint8Array({ minLength: 32, maxLength: 32 });
const diversifier = fc.bigInt({ min: 0n, max: DIVERSIFIER_BOUND - 1n });
const memoField = fc.uint8Array({ minLength: MEMO_BYTES, maxLength: MEMO_BYTES });

const notePayload: fc.Arbitrary<NotePayload> = fc.record({
    asset: u64,
    value: u64,
    rho: field,
    rseed: seed,
    d: diversifier,
    memo: memoField,
});

const KNOWN: NotePayload = {
    asset: 0x0102030405060708n,
    value: 0x1112131415161718n,
    rho: (0x21n << 200n) | 0x22n,
    rseed: Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i),
    d: (0xd1n << 120n) | 0xd2n,
    memo: encodeMemo("hi"),
};

describe("note plaintext codec", () => {
    it("is 224 bytes", () => {
        expect(NOTE_PLAINTEXT_BYTES).toBe(224);
    });

    // The pool reverts on one longer than `AuxValidation.MAX_CIPHERTEXT_LEN`, 256.
    it("travels in a 242-byte wire ciphertext", () => {
        expect(NOTE_CIPHERTEXT_BYTES).toBe(242);
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
                `d2${"00".repeat(14)}d1` +
                `6869${"00".repeat(126)}`,
        );
        expect(decodeNotePayload(encodeNotePayload(KNOWN))).toEqual(KNOWN);
    });

    it("rejects any other length", () => {
        // 96 is the plaintext without its memo field.
        for (const length of [0, 96, NOTE_PLAINTEXT_BYTES - 1, NOTE_PLAINTEXT_BYTES + 1, 256]) {
            expect(() => decodeNotePayload(new Uint8Array(length))).toThrow(/expected 224B/);
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
        expect(encode({ memo: new Uint8Array(MEMO_BYTES - 1) })).toThrow(/memo/);
        expect(encode({ memo: new Uint8Array(MEMO_BYTES + 1) })).toThrow(/memo/);
    });

    it("decodes the seed as a copy of the plaintext bytes", () => {
        // The plaintext buffer is the decryptor's; a view would alias it.
        const buf = encodeNotePayload(KNOWN);
        const { rseed } = decodeNotePayload(buf);
        buf.fill(0);
        expect(rseed).toEqual(KNOWN.rseed);
    });
});

describe("memo field", () => {
    const utf8Length = (text: string) => new TextEncoder().encode(text).length;
    /** Text `encodeMemo` takes: no U+0000, at most `MEMO_BYTES` as UTF-8. */
    const memoText = fc
        .string({ unit: "grapheme" })
        .filter((text) => !text.includes("\0") && utf8Length(text) <= MEMO_BYTES);

    it("is 128 bytes whatever the text", () => {
        fc.assert(
            fc.property(memoText, (text) => {
                expect(encodeMemo(text)).toHaveLength(MEMO_BYTES);
            }),
        );
    });

    it("round-trips any text that fits", () => {
        fc.assert(
            fc.property(memoText, (text) => {
                expect(decodeMemo(encodeMemo(text))).toBe(text === "" ? undefined : text);
            }),
        );
    });

    it("is the text's UTF-8 bytes, then zeros", () => {
        const field = encodeMemo("né");
        expect([...field.subarray(0, 3)]).toEqual([0x6e, 0xc3, 0xa9]);
        expect(field.subarray(3).every((b) => b === 0)).toBe(true);
    });

    it("is all zero for no text, and decodes to none", () => {
        expect(encodeMemo(undefined)).toEqual(new Uint8Array(MEMO_BYTES));
        expect(encodeMemo("")).toEqual(new Uint8Array(MEMO_BYTES));
        expect(EMPTY_MEMO).toEqual(new Uint8Array(MEMO_BYTES));
        expect(decodeMemo(EMPTY_MEMO)).toBeUndefined();
    });

    it("counts bytes, not characters", () => {
        expect(decodeMemo(encodeMemo("a".repeat(128)))).toBe("a".repeat(128));
        expect(() => encodeMemo("a".repeat(129))).toThrow(/memo is 129 bytes as UTF-8, limit 128/);
        // Three bytes each.
        expect(decodeMemo(encodeMemo("租".repeat(42)))).toBe("租".repeat(42));
        expect(() => encodeMemo("租".repeat(43))).toThrow(/memo is 129 bytes/);
    });

    it("rejects U+0000, which the padding could not tell from the end", () => {
        expect(() => encodeMemo("a\0b")).toThrow(/U\+0000/);
        expect(() => encodeMemo("ab\0")).toThrow(/U\+0000/);
    });

    it("rejects a value that is not a string", () => {
        expect(() => encodeMemo(7 as unknown as string)).toThrow(/memo must be a string/);
    });

    it("decodes a sender's malformed bytes without throwing", () => {
        const field = new Uint8Array(MEMO_BYTES);
        field.set([0x61, 0xff, 0x62]);
        expect(decodeMemo(field)).toBe("a\ufffdb");
    });
});
