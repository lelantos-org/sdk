// Sapling-style note encryption.
//
// Sender (knows recipient pk_d):
//   esk    ← Z_q*
//   epk    = B · esk
//   shared = pk_d · esk
//   key    = blake2b("lelantos.note.kdf.v1"  || epk || shared, 32)
//   nonce  = blake2b("lelantos.note.nonce.v1" || epk, 12)
//   ct     = ChaCha20-Poly1305(key, nonce, plaintext)
//
// Receiver (knows ivk):
//   shared = epk · ivk
//   key    = same blake2b
//   nonce  = same blake2b
//   plaintext = ChaCha20-Poly1305 decrypt; null on tag failure.
//
// epk is fresh per note → key is single-use → nonce reuse impossible.
// Per-note nonce derivation is defense-in-depth: any future code path that
// somehow reuses a key with different ephemeral data still gets a distinct
// nonce. Must match `sdk/wasm/jubjub/src/decrypt.rs` byte-for-byte.

import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { blake2b } from "@noble/hashes/blake2";
// Leaf import keeps this module worker-safe (barrel pulls circomlibjs/blake2b).
import type { Field, Jubjub, Point } from "../crypto/index.js";
import { BABYJUB_SUBGROUP_ORDER } from "../crypto/tags.js";
import type { EncryptedNote } from "./note.js";

const KDF_DOMAIN = new TextEncoder().encode("lelantos.note.kdf.v1");
const NONCE_DOMAIN = new TextEncoder().encode("lelantos.note.nonce.v1");

/** @internal */
export interface EncryptArgs {
    J: Jubjub;
    recipientPkD: Point;
    esk: Field;
    plaintext: Uint8Array;
}

/** @internal */
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
    const nonce = noteNonce(epkPacked);
    const ciphertext = chacha20poly1305(key, nonce).encrypt(plaintext);
    return { epk: epkPacked, ciphertext };
}

/** @internal */
// Returns null on tag failure (not-for-me / corrupted).
export function decryptNote({ J, ivk, note }: DecryptArgs): Uint8Array | null {
    return J.tryDecryptNote(ivk, note.epk, note.ciphertext);
}

function noteKey(epkPacked: Uint8Array, sharedPacked: Uint8Array): Uint8Array {
    const h = blake2b.create({ dkLen: 32 });
    h.update(KDF_DOMAIN);
    h.update(epkPacked);
    h.update(sharedPacked);
    return h.digest();
}

function noteNonce(epkPacked: Uint8Array): Uint8Array {
    const h = blake2b.create({ dkLen: 12 });
    h.update(NONCE_DOMAIN);
    h.update(epkPacked);
    return h.digest();
}
