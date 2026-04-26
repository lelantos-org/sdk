// Hex codecs. Sole implementation for the whole SDK.

import type { Field } from "./field.js";

/** `0x`-prefixed lowercase hex of a byte array. */
export function bytesToHex(b: Uint8Array): string {
    let h = "0x";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

/** Bare lowercase hex (no `0x`) of a byte array. */
export function bytesToBareHex(b: Uint8Array): string {
    let h = "";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

const HEX_BODY = /^[0-9a-fA-F]*$/;

/**
 * Decode an optionally-`0x`-prefixed even-length hex string.
 *
 * @throws {TypeError} on odd length or a non-hex character. The previous
 * implementation used `parseInt` per byte, which silently produced `NaN`
 * (coerced to 0) for malformed input.
 */
export function hexToBytes(h: string): Uint8Array {
    const s = h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
    if (s.length % 2 !== 0) {
        throw new TypeError(`hexToBytes: odd-length hex string (${s.length} chars)`);
    }
    if (!HEX_BODY.test(s)) {
        throw new TypeError(`hexToBytes: non-hex character in ${JSON.stringify(h.slice(0, 32))}`);
    }
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    return out;
}

/** Parse an optionally-`0x`-prefixed hex string as a bigint. */
export function hexToBigint(h: string): bigint {
    return BigInt(h.startsWith("0x") || h.startsWith("0X") ? h : `0x${h}`);
}

/** Format a field element as a `0x`-prefixed, zero-padded 32-byte hex word. */
export function fieldToBytes32(x: Field): `0x${string}` {
    return `0x${x.toString(16).padStart(64, "0")}`;
}

/** Minimal-width `0x`-prefixed hex of a bigint, padded to a whole byte. */
export function bigintToHex(n: bigint): `0x${string}` {
    const hex = n.toString(16);
    return `0x${hex.length % 2 ? `0${hex}` : hex}`;
}
