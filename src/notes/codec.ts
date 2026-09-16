// Note-payload codec — plaintext inside an EncryptedNote.
//
// Wire format (112 B, little-endian):
//   asset (8) || value (8) || rho (32) || rcm (32) || rcv_dep (32)
//
// `pk` is reconstructed by the receiver from their own ivk; `rcv` is
// per-spend and is not transmitted. `rcv_dep` is the deposit-anchor Pedersen
// blinder bound into the Merkle leaf; the spender needs it to recompute the
// leaf hash. Do not change without bumping the encryption KDF domain.

// Leaf imports, not the barrel: keeps the worker bundle minimal.
import { bitAt } from "../core/bits.js";
import { FIELD_BYTES, fromLeBytes, toLeBytes } from "../core/bytes.js";
import type { Field } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";
import { WireFormatError } from "../errors/network.js";

const NOTE_ASSET_BYTES = 8;
const NOTE_VALUE_BYTES = 8;
const NOTE_RHO_BYTES = FIELD_BYTES;
const NOTE_RCM_BYTES = FIELD_BYTES;
const NOTE_RCV_DEP_BYTES = FIELD_BYTES;
/** @internal */
export const NOTE_PLAINTEXT_BYTES =
    NOTE_ASSET_BYTES + NOTE_VALUE_BYTES + NOTE_RHO_BYTES + NOTE_RCM_BYTES + NOTE_RCV_DEP_BYTES; // 112

/** @internal */
export interface NotePayload {
    asset: Field;
    value: Field;
    rho: Field;
    rcm: Field;
    rcvDep: Field;
}

/** The plaintext's fields in wire order, with their widths. */
const NOTE_LAYOUT = [
    ["asset", NOTE_ASSET_BYTES],
    ["value", NOTE_VALUE_BYTES],
    ["rho", NOTE_RHO_BYTES],
    ["rcm", NOTE_RCM_BYTES],
    ["rcvDep", NOTE_RCV_DEP_BYTES],
] as const satisfies readonly (readonly [keyof NotePayload, number])[];

export function encodeNotePayload(p: NotePayload): Uint8Array {
    const out = new Uint8Array(NOTE_PLAINTEXT_BYTES);
    let off = 0;
    for (const [field, width] of NOTE_LAYOUT) {
        out.set(toLeBytes(p[field], width), off);
        off += width;
    }
    return out;
}

/** @internal */
export function decodeNotePayload(buf: Uint8Array): NotePayload {
    if (buf.length !== NOTE_PLAINTEXT_BYTES) {
        throw new WireFormatError(
            "$.plaintext",
            `note plaintext: expected ${NOTE_PLAINTEXT_BYTES}B, got ${buf.length}`,
        );
    }
    const out = {} as NotePayload;
    let off = 0;
    for (const [field, width] of NOTE_LAYOUT) {
        out[field] = fromLeBytes(buf.subarray(off, off + width));
        off += width;
    }
    return out;
}

/**
 * On-the-wire ciphertext = 2-byte big-endian clueBits prefix || ChaCha body.
 *
 * @internal
 */
export const CLUE_BITS_PREFIX_BYTES = 2;

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
 * Single source of truth for this packing. It feeds both the 16-bit wire prefix
 * the indexer reads and the `out_clue_bits` witness slot the proof commits to.
 * The contract recomputes the second from the first, so they must agree bit for
 * bit; a mismatch fails verification with no local symptom.
 *
 * Returns `bigint` because the witness slot is a field element. The wire prefix
 * is two bytes, so γ > 16 throws instead of truncating.
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
