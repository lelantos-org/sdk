// Witness builders for the 2x2 MASP circuit. Shared between circuit tests
// and Foundry fixture generators so all three views stay byte-identical.

import { randomJubjubScalar } from "../core/random.js";
import {
    buildNoteCommitment,
    buildNullifierFromNsk,
    type Field,
    type Poseidon,
} from "../crypto/index.js";
import type { Note, SpentNote } from "../notes/note.js";

export interface SpendableCachedNote {
    note: Note;
    nsk: Field;
    leafIndex: number;
}

/** @internal */
export function toSpentNoteFromPath(
    P: Poseidon,
    cached: SpendableCachedNote,
    pathElements: Field[][],
    pathIndices: number[],
): SpentNote {
    const cm = buildNoteCommitment(P, cached.note);
    const nf = buildNullifierFromNsk(P, cached.nsk, cached.note.rho, cm);
    return {
        ...cached.note,
        nsk: cached.nsk,
        cm,
        nf,
        leafIndex: cached.leafIndex,
        pathElements,
        pathIndices,
        isDummy: false,
    };
}

/** Per-dummy blinders. Defaults are fresh; pass values only for fixtures. */
export interface DummyBlinders {
    /** Spend-time value-commitment blinder. MUST be fresh per transaction. */
    rcv?: Field;
    /** Deposit-anchor blinder. Unconstrained here: the leaf check is skipped. */
    rcvDep?: Field;
}

/** @internal */

// Dummy spent slot. is_dummy=1 bypasses Merkle membership + pk check.
//
// nf = Poseidon(TAG_NF, nk, rho, cm) with nk = Poseidon(TAG_NK, 0); fresh `rho`
// keeps nf distinct from prior dummies and any real spend. `cm` must be the
// commitment SpentNote recomputes from the dummy's (zero) fields, since the
// circuit feeds that into the nullifier; a placeholder 0 fails.
//
// `rho` has no default and `rcv` defaults to a fresh scalar because both are
// publicly visible: a reused rho repeats the nullifier, and `cv = 0·gen +
// rcv·H` with rcv = 0 is the identity point in every transaction, which tags
// the slot as a dummy in the public inputs.
export function dummyInputAt(
    P: Poseidon,
    depth: number,
    rho: Field,
    blinders: DummyBlinders = {},
): SpentNote {
    const nsk = 0n;
    const note: Note = {
        asset: 0n,
        value: 0n,
        pk: 0n,
        rho,
        rcm: 0n,
        rcv: blinders.rcv ?? randomJubjubScalar(),
        rcvDep: blinders.rcvDep ?? randomJubjubScalar(),
    };
    const cm = buildNoteCommitment(P, note);
    const nf = buildNullifierFromNsk(P, nsk, rho, cm);
    const pathElements: Field[][] = [];
    for (let i = 0; i < depth; i++) pathElements.push([0n, 0n, 0n]);
    return {
        ...note,
        nsk,
        cm,
        nf,
        leafIndex: 0,
        pathElements,
        pathIndices: new Array(depth).fill(0),
        isDummy: true,
    };
}
