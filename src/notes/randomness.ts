// Per-output randomness factories. Constructs the cryptographic blinders
// that go into a Note (rho/rcm/rcv/rcvDep) and into the per-output aux
// payload (esk for ECDH, fmdR for the FMD clue blinder).
//
// Wallet code consumes these via `freshNoteRandomness` /
// `freshOutputAuxRandomness` / `freshOutput`. The low-level
// `randomFr` / `randomJubjubScalar` CSPRNG primitives still live in
// `wallet/randomness.ts` (Web Crypto wrapper).

import type { Field } from "../crypto/index.js";
import { randomFr, randomJubjubScalar } from "../wallet/randomness.js";

/** @internal */
/// Randomness for a Note's cryptographic fields.
export interface NoteRandomness {
    rho: Field;
    rcm: Field;
    rcv: Field;
    rcvDep: Field;
}

/** @internal */
/// Per-output aux randomness (ECDH ephemeral + FMD clue blinder).
/// Same shape as `bundle/common.ts → OutputRandomness`; renamed here to
/// avoid the `export *` collision with the bundle barrel.
export interface NoteOutputAuxRandomness {
    esk: Field;
    fmdR: Field;
}

/** @internal */
/// Combined per-deposit-slot randomness: Note components + aux.
export interface NoteOutputRandomness extends NoteRandomness {
    aux: NoteOutputAuxRandomness;
}

/** @internal */
export function freshNoteRandomness(): NoteRandomness {
    return {
        rho: randomFr(),
        rcm: randomFr(),
        rcv: randomJubjubScalar(),
        rcvDep: randomJubjubScalar(),
    };
}

/** @internal */
export function freshOutputAuxRandomness(): NoteOutputAuxRandomness {
    return { esk: randomJubjubScalar(), fmdR: randomJubjubScalar() };
}

/** @internal */
export function freshOutput(): NoteOutputRandomness {
    return {
        ...freshNoteRandomness(),
        aux: freshOutputAuxRandomness(),
    };
}
