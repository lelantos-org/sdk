// Note-payload codec — the plaintext that travels inside an EncryptedNote.
//
// Wire format (80 B, little-endian):
//   asset (8) || value (8) || rho (32) || rcm (32)
//
// `pk` is reconstructed by the receiver from their own ivk; `rcv` is
// per-spend (a fresh value commitment randomness) and is not transmitted.
// This format is what the rust indexer + e2e runner already speak; do not
// change without bumping the encryption KDF domain.

import { fromLeBytes, toLeBytes, FIELD_BYTES, type Field } from "./crypto/index";

export const NOTE_ASSET_BYTES = 8;
export const NOTE_VALUE_BYTES = 8;
export const NOTE_RHO_BYTES = FIELD_BYTES;
export const NOTE_RCM_BYTES = FIELD_BYTES;
export const NOTE_PLAINTEXT_BYTES =
    NOTE_ASSET_BYTES + NOTE_VALUE_BYTES + NOTE_RHO_BYTES + NOTE_RCM_BYTES; // 80

export interface NotePayload {
    asset: Field;
    value: Field;
    rho: Field;
    rcm: Field;
}

export function encodeNotePayload(p: NotePayload): Uint8Array {
    const out = new Uint8Array(NOTE_PLAINTEXT_BYTES);
    out.set(toLeBytes(p.asset, NOTE_ASSET_BYTES), 0);
    out.set(toLeBytes(p.value, NOTE_VALUE_BYTES), NOTE_ASSET_BYTES);
    out.set(toLeBytes(p.rho, NOTE_RHO_BYTES), NOTE_ASSET_BYTES + NOTE_VALUE_BYTES);
    out.set(toLeBytes(p.rcm, NOTE_RCM_BYTES), NOTE_ASSET_BYTES + NOTE_VALUE_BYTES + NOTE_RHO_BYTES);
    return out;
}

export function decodeNotePayload(buf: Uint8Array): NotePayload {
    if (buf.length !== NOTE_PLAINTEXT_BYTES) {
        throw new Error(`note plaintext: expected ${NOTE_PLAINTEXT_BYTES}B, got ${buf.length}`);
    }
    const a = NOTE_ASSET_BYTES;
    const v = a + NOTE_VALUE_BYTES;
    const r = v + NOTE_RHO_BYTES;
    return {
        asset: fromLeBytes(buf.slice(0, a)),
        value: fromLeBytes(buf.slice(a, v)),
        rho: fromLeBytes(buf.slice(v, r)),
        rcm: fromLeBytes(buf.slice(r, r + NOTE_RCM_BYTES)),
    };
}

/// On-the-wire ciphertext = 2-byte big-endian clueBits prefix || ChaCha body.
export const CLUE_BITS_PREFIX_BYTES = 2;

export function withClueBitsPrefix(prefix: Uint8Array, body: Uint8Array): Uint8Array {
    if (prefix.length !== CLUE_BITS_PREFIX_BYTES) {
        throw new Error(`clue prefix must be ${CLUE_BITS_PREFIX_BYTES}B`);
    }
    const out = new Uint8Array(prefix.length + body.length);
    out.set(prefix, 0);
    out.set(body, prefix.length);
    return out;
}

export function stripClueBitsPrefix(wire: Uint8Array): { prefix: Uint8Array; body: Uint8Array } {
    if (wire.length < CLUE_BITS_PREFIX_BYTES) {
        throw new Error("ciphertext shorter than clue prefix");
    }
    return {
        prefix: wire.slice(0, CLUE_BITS_PREFIX_BYTES),
        body: wire.slice(CLUE_BITS_PREFIX_BYTES),
    };
}

/// Pack the FMD `clue.bits` (LSB-first byte array, ⌈γ/8⌉B) into the
/// 16-bit big-endian wire prefix the indexer expects.
export function clueBitsToPrefix(bits: Uint8Array, gamma: number): Uint8Array {
    let acc = 0;
    for (let i = 0; i < gamma; i++) {
        const b = (bits[i >> 3] >> (i & 7)) & 1;
        if (b) acc |= 1 << i;
    }
    const out = new Uint8Array(CLUE_BITS_PREFIX_BYTES);
    out[0] = (acc >> 8) & 0xff;
    out[1] = acc & 0xff;
    return out;
}
