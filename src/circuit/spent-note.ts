// Input-slot builders for the transact circuit witness.

import {
    buildNoteCommitment,
    buildNullifierFromNsk,
    derivePk,
    type Field,
    type Poseidon,
} from "../crypto/index.js";
import type { Note, SpentNote } from "../notes/note.js";

export interface SpendableCachedNote {
    note: Note;
    nsk: Field;
    /** Diversifier of the address the note was sent to: `note.pk = Poseidon(TAG_PK, ivk, d)`. */
    d: Field;
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
        d: cached.d,
        cm,
        nf,
        leafIndex: cached.leafIndex,
        pathElements,
        pathIndices,
        isDummy: false,
    };
}

/**
 * A dummy input slot: the zero-value note under `rho` and `rcm`, nullified with `nsk`.
 *
 * `is_dummy = 1` skips Merkle membership and the `asset != 0` check, so the path is zero. The
 * circuit derives the slot's `pk` from `nsk` and `d` on every slot, so the note is committed
 * under `Poseidon(TAG_PK, ivk, 0)`. `cm` and `nf` are the values `SpentNote` recomputes from the
 * slot's fields: `nf = Poseidon(TAG_NF, Poseidon(TAG_NK, nsk), rho, cm)`.
 *
 * The nullifier is public and an observer must not be able to recompute it. Preconditions: `nsk`
 * is the key the spend's real inputs open with, and `rho` and `rcm` are sampled uniformly per
 * dummy. A repeated `(nsk, rho, rcm)` repeats the nullifier.
 *
 * @internal
 */
export function dummyInputAt(
    P: Poseidon,
    depth: number,
    { nsk, rho, rcm }: { nsk: Field; rho: Field; rcm: Field },
): SpentNote {
    const d = 0n;
    const note: Note = { asset: 0n, value: 0n, pk: derivePk(P, nsk, d), rho, rcm };
    const cm = buildNoteCommitment(P, note);
    const nf = buildNullifierFromNsk(P, nsk, rho, cm);
    const pathElements: Field[][] = [];
    for (let i = 0; i < depth; i++) pathElements.push([0n, 0n, 0n]);
    return {
        ...note,
        nsk,
        d,
        cm,
        nf,
        leafIndex: 0,
        pathElements,
        pathIndices: new Array(depth).fill(0),
        isDummy: true,
    };
}
