// Hex codecs, shared by the whole SDK.

import { InvalidArgumentError } from "../errors/config.js";
import { branded, type Hex32 } from "./brand.js";
import { assertRange, type Field } from "./field.js";

/** `0x`-prefixed lowercase hex of a byte array. */
export function bytesToHex(b: Uint8Array): string {
    return `0x${bytesToBareHex(b)}`;
}

/** Bare lowercase hex (no `0x`) of a byte array. */
export function bytesToBareHex(b: Uint8Array): string {
    let h = "";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

const HEX_BODY = /^[0-9a-fA-F]*$/;

/** `h` without its `0x` / `0X` prefix, if it has one. */
export function strip0x(h: string): string {
    return h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
}

/**
 * Decode an optionally-`0x`-prefixed even-length hex string.
 *
 * @throws {InvalidArgumentError} on odd length or a non-hex character.
 */
export function hexToBytes(h: string): Uint8Array {
    const s = strip0x(h);
    if (s.length % 2 !== 0) {
        throw new InvalidArgumentError(`hexToBytes: odd-length hex string (${s.length} chars)`, {
            argument: "hex",
        });
    }
    if (!HEX_BODY.test(s)) {
        // The value is not echoed: callers decode keys and signatures with this.
        throw new InvalidArgumentError("hexToBytes: non-hex character", { argument: "hex" });
    }
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    return out;
}

/** Parse an optionally-`0x`-prefixed hex string as a bigint. */
export function hexToBigint(h: string): bigint {
    return BigInt(`0x${strip0x(h)}`);
}

/** One past the largest value representable in 32 bytes. */
const TWO_POW_256 = 1n << 256n;

/**
 * Format a field element as a `0x`-prefixed, zero-padded 32-byte hex word.
 *
 * Range-checked because the result is branded `Hex32` without validation and
 * feeds ABI encoding and persisted note records. Unchecked, `-1n` pads to a
 * 64-character string containing a minus sign, and `2n ** 256n` yields 65 digits.
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
    if (n < 0n) {
        throw new InvalidArgumentError("bigintToHex: value is negative", { argument: "n" });
    }
    const hex = n.toString(16);
    return `0x${hex.length % 2 ? `0${hex}` : hex}`;
}
