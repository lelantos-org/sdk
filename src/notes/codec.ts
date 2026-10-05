// Note-payload codec: the plaintext inside an EncryptedNote.
//
// Wire format (96 B, little-endian):
//   asset (8) || value (8) || rho (32) || rseed (32) || d (16)
//
// `rseed` expands to the note's `rcm`, the ECDH ephemeral and the FMD blinder (`./seed.ts`). `d`
// is the diversifier of the address the note is for; the receiver derives `pk` from it and their
// own ivk.
//
// The length is the only format discriminator: the encryption KDF and nonce domains do not name
// the layout, so `decodeNotePayload` rejects every other length.

// Leaf imports, not the barrel: keeps the worker bundle minimal.
import { bitAt } from "../core/bits.js";
import { assertByteLength, FIELD_BYTES, fromLeBytes, toLeBytes } from "../core/bytes.js";
import { DIVERSIFIER_BYTES } from "../crypto/diversified-base.js";
import type { Field } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";
import { WireFormatError } from "../errors/network.js";

const NOTE_ASSET_BYTES = 8;
const NOTE_VALUE_BYTES = 8;
const NOTE_RHO_BYTES = FIELD_BYTES;
const NOTE_RSEED_BYTES = 32;

const NOTE_VALUE_OFFSET = NOTE_ASSET_BYTES;
const NOTE_RHO_OFFSET = NOTE_VALUE_OFFSET + NOTE_VALUE_BYTES;
const NOTE_RSEED_OFFSET = NOTE_RHO_OFFSET + NOTE_RHO_BYTES;
const NOTE_D_OFFSET = NOTE_RSEED_OFFSET + NOTE_RSEED_BYTES;

/** @internal */
export const NOTE_PLAINTEXT_BYTES = NOTE_D_OFFSET + DIVERSIFIER_BYTES; // 96

/** @internal */
export interface NotePayload {
    asset: Field;
    value: Field;
    rho: Field;
    /** Seed of the output's randomness; see `expandSeed`. 32 bytes. */
    rseed: Uint8Array;
    /** Diversifier of the recipient address, in `[0, 2^128)`. */
    d: Field;
}

/**
 * @throws {InvalidArgumentError} when `rseed` is not 32 bytes or an integer field exceeds its
 * width.
 */
export function encodeNotePayload(p: NotePayload): Uint8Array {
    assertByteLength(p.rseed, NOTE_RSEED_BYTES, "rseed");
    const out = new Uint8Array(NOTE_PLAINTEXT_BYTES);
    out.set(toLeBytes(p.asset, NOTE_ASSET_BYTES), 0);
    out.set(toLeBytes(p.value, NOTE_VALUE_BYTES), NOTE_VALUE_OFFSET);
    out.set(toLeBytes(p.rho, NOTE_RHO_BYTES), NOTE_RHO_OFFSET);
    out.set(p.rseed, NOTE_RSEED_OFFSET);
    out.set(toLeBytes(p.d, DIVERSIFIER_BYTES), NOTE_D_OFFSET);
    return out;
}

/**
 * Splits the plaintext by offset. `rho` is not range-checked: it can exceed the field modulus.
 *
 * @throws {WireFormatError} when `buf` is not {@link NOTE_PLAINTEXT_BYTES} long.
 * @internal
 */
export function decodeNotePayload(buf: Uint8Array): NotePayload {
    if (buf.length !== NOTE_PLAINTEXT_BYTES) {
        throw new WireFormatError(
            "$.plaintext",
            `note plaintext: expected ${NOTE_PLAINTEXT_BYTES}B, got ${buf.length}`,
        );
    }
    return {
        asset: fromLeBytes(buf.subarray(0, NOTE_VALUE_OFFSET)),
        value: fromLeBytes(buf.subarray(NOTE_VALUE_OFFSET, NOTE_RHO_OFFSET)),
        rho: fromLeBytes(buf.subarray(NOTE_RHO_OFFSET, NOTE_RSEED_OFFSET)),
        rseed: buf.slice(NOTE_RSEED_OFFSET, NOTE_D_OFFSET),
        d: fromLeBytes(buf.subarray(NOTE_D_OFFSET)),
    };
}

/**
 * On-the-wire ciphertext = 2-byte big-endian clueBits prefix || ChaCha body.
 *
 * @internal
 */
export const CLUE_BITS_PREFIX_BYTES = 2;

/** Poly1305 tag `encryptNote` appends to the plaintext. */
const AEAD_TAG_BYTES = 16;

/**
 * A note's wire ciphertext, 114 bytes: the clueBits prefix, the encrypted plaintext and its AEAD
 * tag.
 *
 * @internal
 */
export const NOTE_CIPHERTEXT_BYTES = CLUE_BITS_PREFIX_BYTES + NOTE_PLAINTEXT_BYTES + AEAD_TAG_BYTES;

export function withClueBitsPrefix(prefix: Uint8Array, body: Uint8Array): Uint8Array {
    if (prefix.length !== CLUE_BITS_PREFIX_BYTES) {
        throw new InvalidArgumentError(`clue prefix must be ${CLUE_BITS_PREFIX_BYTES}B`, {
            argument: "prefix",
        });
    }
    const out = new Uint8Array(prefix.length + body.length);
    out.set(prefix, 0);
    out.set(body, prefix.length);
    return out;
}

/** @internal */
export function stripClueBitsPrefix(wire: Uint8Array): { prefix: Uint8Array; body: Uint8Array } {
    if (wire.length < CLUE_BITS_PREFIX_BYTES) {
        throw new WireFormatError("$.ciphertext", "ciphertext shorter than clue prefix");
    }
    return {
        prefix: wire.slice(0, CLUE_BITS_PREFIX_BYTES),
        body: wire.slice(CLUE_BITS_PREFIX_BYTES),
    };
}

/**
 * Pack the FMD `clue.bits` (LSB-first byte array, ⌈γ/8⌉B) into one integer.
 *
 * Feeds both the 16-bit wire prefix the indexer reads and the `out_clue_bits` witness slot the
 * proof commits to. The contract recomputes the second from the first, so they must agree bit
 * for bit; a mismatch fails verification with no local symptom.
 *
 * Returns `bigint` because the witness slot is a field element. Throws for γ > 16, which the
 * two-byte wire prefix cannot hold.
 *
 * @internal
 */
export function packClueBits(bits: Uint8Array, gamma: number): bigint {
    if (gamma > CLUE_BITS_PREFIX_BYTES * 8) {
        throw new InvalidArgumentError(
            `clue gamma ${gamma} exceeds the ${CLUE_BITS_PREFIX_BYTES * 8}-bit wire prefix`,
            { argument: "gamma" },
        );
    }
    let acc = 0n;
    for (let i = 0; i < gamma; i++) {
        if (bitAt(bits, i)) acc |= 1n << BigInt(i);
    }
    return acc;
}

/**
 * The 16-bit big-endian wire prefix, derived from {@link packClueBits}.
 *
 * @internal
 */
export function clueBitsToPrefix(bits: Uint8Array, gamma: number): Uint8Array {
    const acc = Number(packClueBits(bits, gamma));
    const out = new Uint8Array(CLUE_BITS_PREFIX_BYTES);
    out[0] = (acc >> 8) & 0xff;
    out[1] = acc & 0xff;
    return out;
}
