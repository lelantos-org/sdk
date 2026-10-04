// Note plaintext and encrypted-note types. Mirrors circuits/test/ref/note.ts
// so SDK and circuit witnesses share one shape.

import type { Field } from "../crypto/poseidon.js";

export interface Note {
    asset: Field;
    value: Field;
    pk: Field; // Poseidon(TAG_PK, ivk, d) — the cm-binding pubkey
    rho: Field;
    rcm: Field;
}

/** @internal */
export interface SpentNote extends Note {
    nsk: Field;
    /** Diversifier `pk` is derived under: `pk = Poseidon(TAG_PK, ivk, d)`. Zero on a dummy. */
    d: Field;
    cm: Field;
    nf: Field;
    leafIndex: number;
    pathElements: Field[][];
    pathIndices: number[];
    isDummy: boolean;
}

/** @internal */
// Encrypted on-chain note. epk = sender's ephemeral Baby-Jubjub pubkey
// (32B packed); ct = ChaCha20-Poly1305(plaintext) under KDF(esk·pk_d).
export interface EncryptedNote {
    epk: Uint8Array;
    ciphertext: Uint8Array;
}
