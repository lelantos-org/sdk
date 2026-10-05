// Diversifiers: the 16-byte value that selects one address of a viewing key.
//
//   dvk     = blake2b-128( "lelantos.addr.dvk.v1" || LE32(ivk) )
//   d_bytes = AES-128-encrypt_dvk( LE4(index) || 0^12 )          index in [0, 2^32)
//   d       = d_bytes read little-endian, in [0, 2^128)
//
// One raw AES block: no mode, no padding, no IV. AES is a permutation, so distinct indices give
// distinct diversifiers, and `dvk` recovers the index by decrypting.
//
// A block decrypts to twelve trailing zero bytes for 2^32 of the 2^128 inputs, so a diversifier
// made under another key is accepted with probability 2^-96.

import { ecb } from "@noble/ciphers/aes";
import { blake2b } from "@noble/hashes/blake2";
import { assertByteLength, fromLeBytes, toLeBytes } from "../core/bytes.js";
import { assertField, type Field } from "../core/field.js";
import { assertDiversifier, DIVERSIFIER_BYTES } from "../crypto/diversified-base.js";
import { InvalidArgumentError } from "../errors/config.js";

const DVK_DOMAIN = new TextEncoder().encode("lelantos.addr.dvk.v1");

/** Byte width of the diversifier key: one AES-128 key. */
const DVK_BYTES = 16;

/** Leading plaintext bytes that carry the index; the rest of the block is zero. */
const INDEX_BYTES = 4;

/** Exclusive upper bound of a diversifier index: `2^32`. */
export const DIVERSIFIER_INDEX_BOUND = 2 ** 32;

/** Index of the account's default address. */
export const DEFAULT_DIVERSIFIER_INDEX = 0;

/** The single-block AES-128 permutation keyed by `dvk`. */
function blockCipher(dvk: Uint8Array) {
    assertByteLength(dvk, DVK_BYTES, "dvk");
    return ecb(dvk, { disablePadding: true });
}

/**
 * The diversifier key of `ivk`.
 *
 * Its holder enumerates the account's diversifiers and recognises them, so it links the account's
 * addresses to each other. It grants no decryption, detection or spend authority.
 *
 * @throws {InvalidArgumentError} when `ivk` is not a canonical field element.
 */
export function deriveDiversifierKey(ivk: Field): Uint8Array {
    assertField(ivk, "ivk");
    const h = blake2b.create({ dkLen: DVK_BYTES });
    h.update(DVK_DOMAIN);
    h.update(toLeBytes(ivk));
    return h.digest();
}

/**
 * The 16 diversifier bytes at `index`.
 *
 * @throws {InvalidArgumentError} when `index` is not an integer in `[0, 2^32)` or `dvk` is not
 * 16 bytes.
 */
export function diversifierAt(dvk: Uint8Array, index: number): Uint8Array {
    if (!Number.isInteger(index) || index < 0 || index >= DIVERSIFIER_INDEX_BOUND) {
        throw new InvalidArgumentError(
            `diversifier index must be an integer in [0, 2^32); got ${index}`,
            { argument: "index" },
        );
    }
    const block = new Uint8Array(DIVERSIFIER_BYTES);
    new DataView(block.buffer).setUint32(0, index, true);
    return blockCipher(dvk).encrypt(block);
}

/**
 * The index `dBytes` was made at under `dvk`, or `null` when it was not made under `dvk`.
 *
 * @throws {InvalidArgumentError} when `dBytes` or `dvk` is not 16 bytes.
 */
export function diversifierIndex(dvk: Uint8Array, dBytes: Uint8Array): number | null {
    assertByteLength(dBytes, DIVERSIFIER_BYTES, "dBytes");
    const block = blockCipher(dvk).decrypt(dBytes);
    let padding = 0;
    for (let i = INDEX_BYTES; i < DIVERSIFIER_BYTES; i++) padding |= block[i]!;
    if (padding !== 0) return null;
    return new DataView(block.buffer, block.byteOffset).getUint32(0, true);
}

/**
 * A diversifier as an integer: its 16 bytes read little-endian.
 *
 * @throws {InvalidArgumentError} when `dBytes` is not 16 bytes.
 */
export function diversifierToField(dBytes: Uint8Array): Field {
    assertByteLength(dBytes, DIVERSIFIER_BYTES, "dBytes");
    return fromLeBytes(dBytes);
}

/**
 * Inverse of {@link diversifierToField}.
 *
 * @throws {InvalidArgumentError} when `d` is not in `[0, 2^128)`.
 */
export function diversifierToBytes(d: Field): Uint8Array {
    assertDiversifier(d);
    return toLeBytes(d, DIVERSIFIER_BYTES);
}

/**
 * The diversifier at `index` under the diversifier key of `ivk`, as an integer.
 *
 * A function of `ivk` alone, so every holder of a viewing key computes it.
 *
 * @throws {InvalidArgumentError} when `ivk` is not a canonical field element or `index` is not an
 * integer in `[0, 2^32)`.
 * @internal
 */
export function diversifierForIndex(ivk: Field, index: number): Field {
    return diversifierToField(diversifierAt(deriveDiversifierKey(ivk), index));
}

/**
 * The diversifier of the account's default address: {@link diversifierForIndex} at
 * {@link DEFAULT_DIVERSIFIER_INDEX}.
 *
 * @throws {InvalidArgumentError} when `ivk` is not a canonical field element.
 */
export function defaultDiversifier(ivk: Field): Field {
    return diversifierForIndex(ivk, DEFAULT_DIVERSIFIER_INDEX);
}
