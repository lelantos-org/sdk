// Note plaintext + encrypted-note types. Mirrors circuits/src/test/helpers.ts
// so SDK and circuit witnesses share a single shape.

import type { Field } from "./crypto/index.js";

export interface Note {
    asset: Field;
    value: Field;
    pk: Field; // Poseidon(TAG_PK, ivk) — the cm-binding pubkey
    rho: Field;
    rcm: Field;
    rcv: Field;
    /// Pedersen blinder for the deposit-anchor value commitment cv_dep.
    /// Encoded into the encrypted plaintext so the recipient can spend
    /// without leaking pk/rho/rcm to the relayer at flush time.
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

// Encrypted on-chain note. epk = sender's ephemeral Baby-Jubjub pubkey
// (32B packed); ct = ChaCha20-Poly1305(plaintext) under KDF(esk·pk_d).
export interface EncryptedNote {
    epk: Uint8Array;
    ciphertext: Uint8Array;
}
