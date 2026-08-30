// keccak-256 over bytes or a hex string.
//
// Backed by `@noble/hashes`, which the SDK already depends on, rather than
// viem. viem's `keccak256` is correct and identical, but reaching for it drags
// viem into modules that otherwise need none of it — key derivation and the
// x402 ephemeral path both hash without ever touching a chain.
//
// Modules that already encode ABI data (`protocol/abi-hash.ts`,
// `circuit/compression.ts`) keep viem's, since viem is in their graph anyway.

import { keccak_256 } from "@noble/hashes/sha3";
import { branded, type Hex32 } from "./brand.js";
import { bytesToHex, hexToBytes } from "./hex.js";

/**
 * keccak-256 digest as a `0x`-prefixed 32-byte hex string.
 *
 * A string input is read as hex, matching viem's `keccak256` — the two are
 * interchangeable, and `encoding-parity.test.ts` pins the digests either way.
 */
export function keccak256(data: Uint8Array | string): Hex32 {
    const bytes = typeof data === "string" ? hexToBytes(data) : data;
    return branded<Hex32>(bytesToHex(keccak_256(bytes)));
}

/**
 * `blocks * 32` bytes derived from `data` by counter-mode keccak:
 * `keccak(0x00 || data) || keccak(0x01 || data) || ...`.
 *
 * A single keccak digest is 256 bits, which is too narrow to reduce into a
 * 251- or 254-bit modulus without a measurable bias — see
 * `reduceWideToField`. This widens the draw instead of changing the hash.
 *
 * The counter is a prefix, not a suffix, so no two blocks can be produced
 * from the same keccak input by shifting `data`.
 */
export function keccakExpand(data: Uint8Array, blocks: number): Uint8Array {
    if (!Number.isInteger(blocks) || blocks < 1 || blocks > 255) {
        throw new RangeError(`keccakExpand: blocks must be an integer in [1, 255], got ${blocks}`);
    }
    const out = new Uint8Array(blocks * 32);
    const buf = new Uint8Array(1 + data.length);
    buf.set(data, 1);
    for (let i = 0; i < blocks; i++) {
        buf[0] = i;
        out.set(keccak_256(buf), i * 32);
    }
    return out;
}
