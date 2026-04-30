// Sapling-style note encryption.
//
// Sender (knows recipient pk_d):
//   esk    ← Z_q*
//   epk    = B · esk
//   shared = pk_d · esk
//   key    = blake2b("lelantos.note.kdf.v1" || epk || shared, 32)
//   ct     = ChaCha20-Poly1305(key, nonce=0¹², plaintext)
//
// Receiver (knows ivk):
//   shared = epk · ivk
//   key    = same blake2b
//   plaintext = ChaCha20-Poly1305 decrypt; null on tag failure.
//
// Nonce 0¹² is safe because epk is fresh per note → key is single-use.
// Same construction as Sapling.

import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { blake2b } from "@noble/hashes/blake2";
import { type Jubjub, BABYJUB_SUBGROUP_ORDER, type Field, type Point } from "./crypto/index";
import { WasmJubjub } from "./crypto/jubjub-wasm";
import type { EncryptedNote } from "./notes";

const KDF_DOMAIN = new TextEncoder().encode("lelantos.note.kdf.v1");
const ZERO_NONCE = new Uint8Array(12);

export interface EncryptArgs {
    J: Jubjub;
    recipientPkD: Point;
    esk: Field;
    plaintext: Uint8Array;
}

export interface DecryptArgs {
    J: Jubjub;
    ivk: Field;
    note: EncryptedNote;
}

export function encryptNote({ J, recipientPkD, esk, plaintext }: EncryptArgs): EncryptedNote {
    const eskMod = esk % BABYJUB_SUBGROUP_ORDER;
    if (eskMod === 0n) throw new Error("esk must be non-zero mod q");

    const epk = J.mulPointEscalar(J.base8, eskMod);
    const shared = J.mulPointEscalar(recipientPkD, eskMod);
    if (!J.inSubgroup(shared)) throw new Error("shared not in subgroup");

    const epkPacked = J.packPoint(epk);
    const key = noteKey(epkPacked, J.packPoint(shared));
    const ciphertext = chacha20poly1305(key, ZERO_NONCE).encrypt(plaintext);
    return { epk: epkPacked, ciphertext };
}

// Returns null on tag failure (not-for-me / corrupted).
export function decryptNote({ J, ivk, note }: DecryptArgs): Uint8Array | null {
    if (J instanceof WasmJubjub) {
        return J.tryDecryptNote(ivk, note.epk, note.ciphertext);
    }
    const epk = J.unpackPoint(note.epk);
    if (!epk || !J.inSubgroup(epk)) return null;

    const shared = J.mulPointEscalar(epk, ivk % BABYJUB_SUBGROUP_ORDER);
    const key = noteKey(note.epk, J.packPoint(shared));
    try {
        return chacha20poly1305(key, ZERO_NONCE).decrypt(note.ciphertext);
    } catch {
        return null;
    }
}

function noteKey(epkPacked: Uint8Array, sharedPacked: Uint8Array): Uint8Array {
    const h = blake2b.create({ dkLen: 32 });
    h.update(KDF_DOMAIN);
    h.update(epkPacked);
    h.update(sharedPacked);
    return h.digest();
}
