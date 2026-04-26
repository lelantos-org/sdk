// LSB-first bit packing. Sole implementation for the whole SDK.
//
// Convention: bit `i` lives in byte `i >> 3` at position `i & 7`, counting
// from the least-significant bit. Matches the FMD clue wire format and the
// circuit's `Num2Bits` decomposition.

/** Read bit `i` (LSB-first) from a packed byte array. Returns 0 or 1. */
export function bitAt(packed: Uint8Array, i: number): number {
    return (packed[i >> 3] >> (i & 7)) & 1;
}

/** Pack `bits` (each 0 or 1) LSB-first into `ceil(bits.length / 8)` bytes. */
export function packBits(bits: number[] | Uint8Array): Uint8Array {
    const out = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < bits.length; i++) {
        if (bits[i]) out[i >> 3] |= 1 << (i & 7);
    }
    return out;
}

/** Unpack the first `count` bits (LSB-first) from a packed byte array. */
export function unpackBits(packed: Uint8Array, count: number): number[] {
    const out: number[] = new Array(count);
    for (let i = 0; i < count; i++) out[i] = bitAt(packed, i);
    return out;
}
