// Byte conversions for field elements.
//
// Little-endian is the default: on-chain serialisation uses 32-byte LE. The
// big-endian pair exists for the wasm Poseidon boundary, whose wire contract
// is BE, and writes into a caller-owned buffer because that path runs ~350K
// times in a full tree build and must not allocate per call.

import type { Field } from "./field.js";

/** Width of a serialised field element, in bytes. */
export const FIELD_BYTES = 32;

export function toLeBytes(x: Field, len = FIELD_BYTES): Uint8Array {
    const out = new Uint8Array(len);
    let v = x;
    for (let i = 0; i < len; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    if (v !== 0n) throw new Error(`field exceeds ${len} bytes`);
    return out;
}

export function fromLeBytes(b: Uint8Array): Field {
    let v = 0n;
    for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
}

/**
 * Write `x` big-endian into `dst` at `offset`, over `FIELD_BYTES`.
 *
 * Writes in place rather than returning a fresh array: the caller reuses one
 * scratch buffer across calls. Unlike `toLeBytes` this does not check for
 * overflow — every caller has already run `assertField`, which is strictly
 * stronger than "fits in 32 bytes".
 */
export function writeBeInto(dst: Uint8Array, offset: number, x: Field): void {
    let v = x;
    for (let i = FIELD_BYTES - 1; i >= 0; i--) {
        dst[offset + i] = Number(v & 0xffn);
        v >>= 8n;
    }
}

export function fromBeBytes(b: Uint8Array): Field {
    let v = 0n;
    for (const byte of b) v = (v << 8n) | BigInt(byte);
    return v;
}
