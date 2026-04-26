// Per-output randomness factories: blinders for a Note (rho/rcm/rcv/rcvDep)
// and for the per-output aux payload (esk for ECDH, fmdR for the FMD clue
// blinder).

import { randomFr, randomJubjubScalar } from "../core/random.js";
import type { Field } from "../crypto/poseidon.js";

/** @internal */
export interface NoteRandomness {
    rho: Field;
    rcm: Field;
    rcv: Field;
    rcvDep: Field;
}

/**
 * Per-output aux randomness (ECDH ephemeral + FMD clue blinder). Same shape
 * as `bundle/common.ts → OutputRandomness`, under a distinct name so both are
 * exportable from the public barrel.
 *
 * @internal
 */
export interface NoteOutputAuxRandomness {
    esk: Field;
    fmdR: Field;
}

/**
 * Combined per-deposit-slot randomness: Note components + aux.
 *
 * @internal
 */
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
