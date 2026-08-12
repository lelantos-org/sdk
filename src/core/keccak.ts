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
