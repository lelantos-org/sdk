// Hex codecs. Sole implementation for the whole SDK.

import { branded, type Hex32 } from "./brand.js";
import { InvalidArgumentError } from "./errors.js";
import { assertRange, type Field } from "./field.js";

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
 * @throws {TypeError} on odd length or a non-hex character.
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

/** One past the largest value representable in 32 bytes. */
const TWO_POW_256 = 1n << 256n;

/**
 * Format a field element as a `0x`-prefixed, zero-padded 32-byte hex word.
 *
 * Range-checked because this brands its result `Hex32` through the unvalidated
 * escape hatch, and the output feeds ABI encoding and persisted note records.
 * `(-1n).toString(16)` is `"-1"`, which `padStart(64)` pads to a 64-character
 * string containing a minus sign — long enough to pass a length check — and
 * `2n ** 256n` overflows to 65 digits with `padStart` a no-op.
 */
export function fieldToBytes32(x: Field): Hex32 {
    assertRange(x, 0n, TWO_POW_256, "fieldToBytes32 input", "a 32-byte unsigned integer");
    return branded<Hex32>(`0x${x.toString(16).padStart(64, "0")}`);
}

/**
 * Minimal-width `0x`-prefixed hex of a bigint, padded to a whole byte.
 *
 * Negatives are rejected rather than emitted as `"0x-1"`, which is typed
 * `` `0x${string}` `` but is not hex.
 */
export function bigintToHex(n: bigint): `0x${string}` {
    if (n < 0n) throw new InvalidArgumentError(`bigintToHex: ${n} is negative`);
    const hex = n.toString(16);
    return `0x${hex.length % 2 ? `0${hex}` : hex}`;
}
