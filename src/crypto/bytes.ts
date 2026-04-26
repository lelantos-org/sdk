// Little-endian byte conversions for field elements. On-chain serialisation uses 32-byte LE.

import type { Field } from "./poseidon.js";

/** @internal */
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
    for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
}
