// Note plaintext + encrypted-note types. Mirror circuits/src/test/helpers.ts
// `Note` / `SpentNote` so SDK and circuit witnesses share a single shape.

import type { Field } from "./crypto/index.js";

export interface Note {
    asset: Field;
    value: Field;
    pk: Field; // Poseidon(TAG_PK, ivk) — the cm-binding pubkey
    rho: Field;
    rcm: Field;
    rcv: Field;
    /// Pedersen blinder for the deposit-anchor value commitment cv_dep.
    /// Encoded into the encrypted note plaintext so the recipient can spend
    /// the note without leaking pk/rho/rcm to the relayer at flush time.
    rcvDep: Field;
}

export interface SpentNote extends Note {
    nsk: Field;
    cm: Field;
    nf: Field;
    leafIndex: number;
    pathElements: Field[][];
    pathIndices: number[];
    isDummy: boolean;
}

// Encrypted on-chain note payload. epk is the sender's ephemeral Baby-Jubjub
// public key (32-byte packed); ct = ChaCha20-Poly1305(plaintext) under
// KDF(esk · pk_d_recipient).
export interface EncryptedNote {
    epk: Uint8Array; // 32 bytes (Baby-Jubjub packed)
    ciphertext: Uint8Array; // includes Poly1305 tag
}
