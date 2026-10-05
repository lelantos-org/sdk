import { createCipheriv, createDecipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fromLeBytes } from "../core/bytes.js";
import { bytesToBareHex } from "../core/hex.js";
import { DIVERSIFIER_BOUND } from "../crypto/diversified-base.js";
import {
    DIVERSIFIER_INDEX_BOUND,
    defaultDiversifier,
    deriveDiversifierKey,
    diversifierAt,
    diversifierForIndex,
    diversifierIndex,
    diversifierToBytes,
    diversifierToField,
} from "./diversifier.js";

const INDICES = [0, 1, 2, 255, 256, 65_535, 0x0102_0304, 2 ** 31, 2 ** 32 - 1];

const dvk = deriveDiversifierKey(7n);
const otherDvk = deriveDiversifierKey(8n);

/**
 * One raw AES-128 block under `dvk` from an independent implementation, so the mode, padding and
 * plaintext layout are pinned rather than inherited from the library under test.
 */
function aesBlock(direction: "encrypt" | "decrypt", block: Uint8Array): Uint8Array {
    const create = direction === "encrypt" ? createCipheriv : createDecipheriv;
    const cipher = create("aes-128-ecb", dvk, null).setAutoPadding(false);
    return new Uint8Array([...cipher.update(block), ...cipher.final()]);
}

describe("deriveDiversifierKey", () => {
    it("is a fixed 16-byte function of ivk", () => {
        expect(dvk).toHaveLength(16);
        expect(deriveDiversifierKey(7n)).toEqual(dvk);
        expect(otherDvk).not.toEqual(dvk);
    });

    // Pinned: a change strands every address already handed out.
    it("matches its recorded vector", () => {
        expect(bytesToBareHex(deriveDiversifierKey(1n))).toBe("c3b8183781ea9fa020c04358e0fddd24");
    });

    it("rejects a non-canonical ivk", () => {
        expect(() => deriveDiversifierKey(-1n)).toThrow(/canonical field element/);
        expect(() => deriveDiversifierKey(1n << 254n)).toThrow(/canonical field element/);
    });
});

describe("diversifierAt / diversifierIndex", () => {
    it.each(INDICES)("round-trips index %i", (index) => {
        const d = diversifierAt(dvk, index);
        expect(d).toHaveLength(16);
        expect(diversifierIndex(dvk, d)).toBe(index);
    });

    it.each(INDICES)("index %i of another key decrypts to null", (index) => {
        expect(diversifierIndex(dvk, diversifierAt(otherDvk, index))).toBeNull();
        expect(diversifierIndex(otherDvk, diversifierAt(dvk, index))).toBeNull();
    });

    it("gives distinct diversifiers for distinct indices", () => {
        const seen = new Set(
            Array.from({ length: 512 }, (_, index) => bytesToBareHex(diversifierAt(dvk, index))),
        );
        expect(seen.size).toBe(512);
    });

    it.each(INDICES)("index %i is one raw AES-128 block over LE4(index) || 0^12", (index) => {
        const block = new Uint8Array(16);
        new DataView(block.buffer).setUint32(0, index, true);
        const want = aesBlock("encrypt", block);
        expect(diversifierAt(dvk, index)).toEqual(want);
        expect(aesBlock("decrypt", want)).toEqual(block);
    });

    it("rejects an index outside [0, 2^32)", () => {
        for (const index of [-1, DIVERSIFIER_INDEX_BOUND, 1.5, Number.NaN]) {
            expect(() => diversifierAt(dvk, index)).toThrow(/integer in \[0, 2\^32\)/);
        }
    });

    it("rejects a diversifier or key that is not 16 bytes", () => {
        expect(() => diversifierIndex(dvk, new Uint8Array(15))).toThrow(/must be 16 bytes/);
        expect(() => diversifierIndex(dvk, new Uint8Array(17))).toThrow(/must be 16 bytes/);
        expect(() => diversifierIndex(dvk, new Uint8Array(32))).toThrow(/must be 16 bytes/);
        expect(() => diversifierAt(new Uint8Array(32), 0)).toThrow(/dvk must be 16 bytes/);
        expect(() => diversifierIndex(new Uint8Array(15), new Uint8Array(16))).toThrow(
            /dvk must be 16 bytes/,
        );
    });

    it("accepts only blocks whose twelve trailing plaintext bytes are zero", () => {
        for (let i = 4; i < 16; i++) {
            const block = new Uint8Array(16);
            block[i] = 1;
            expect(diversifierIndex(dvk, aesBlock("encrypt", block))).toBeNull();
        }
    });
});

describe("diversifier as an integer", () => {
    it.each(INDICES)("index %i round-trips through the field form", (index) => {
        const bytes = diversifierAt(dvk, index);
        const d = diversifierToField(bytes);
        expect(d).toBe(fromLeBytes(bytes));
        expect(d).toBeLessThan(DIVERSIFIER_BOUND);
        expect(diversifierToBytes(d)).toEqual(bytes);
        expect(diversifierIndex(dvk, diversifierToBytes(d))).toBe(index);
        expect(diversifierIndex(otherDvk, diversifierToBytes(d))).toBeNull();
    });

    it.each(INDICES)("index %i of an ivk is its dvk's diversifier as an integer", (index) => {
        expect(diversifierForIndex(7n, index)).toBe(diversifierToField(diversifierAt(dvk, index)));
    });

    it("the default diversifier is the one at index 0", () => {
        expect(defaultDiversifier(7n)).toBe(diversifierForIndex(7n, 0));
    });

    it("rejects a non-canonical ivk ahead of a bad index", () => {
        expect(() => diversifierForIndex(-1n, -1)).toThrow(/canonical field element/);
        expect(() => diversifierForIndex(7n, -1)).toThrow(/integer in \[0, 2\^32\)/);
    });

    it("reads the bytes little-endian", () => {
        const bytes = new Uint8Array(16);
        bytes[0] = 1;
        expect(diversifierToField(bytes)).toBe(1n);
        bytes[15] = 0x80;
        expect(diversifierToField(bytes)).toBe((1n << 127n) + 1n);
    });

    it("treats a value outside [0, 2^128) as no diversifier", () => {
        expect(() => diversifierToBytes(DIVERSIFIER_BOUND)).toThrow(/16-byte diversifier/);
        expect(() => diversifierToBytes(-1n)).toThrow(/16-byte diversifier/);
        expect(() => diversifierToField(new Uint8Array(32))).toThrow(/must be 16 bytes/);
    });
});
