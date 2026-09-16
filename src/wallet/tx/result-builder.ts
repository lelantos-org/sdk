// The commitment lists every operation result carries.

import { branded, type CircuitAmount, type Hex32 } from "../../core/brand.js";
import { fieldToBytes32 } from "../../core/hex.js";
import type { Field } from "../../crypto/index.js";
import { InternalError } from "../../errors/base.js";
import type { Note } from "../../notes/note.js";

/**
 * Index of an output slot, `0 .. nOut - 1`.
 *
 * A plain `number` because `nOut` depends on the circuit shape and is not known at compile time.
 * {@link outputCommitments} bounds-checks it against the bundle's outputs.
 */
export type OutputSlot = number;

/** Shared subset of `BuiltBundle` / `BuiltDeposit`. */
interface BuiltLike {
    /** One per output slot: `nOut` at spend, always 1 for a deposit. */
    cm: Field[];
    producedNotes: Note[];
}

/** The commitment lists of a result, and the value this wallet recovers from them. */
export interface OutputCommitments {
    /** Every output commitment, in slot order. */
    commitments: Hex32[];
    /** Own slots with non-zero value: what this wallet's scanner will store. */
    ownCommitments: Hex32[];
    /** Every slot with non-zero value; zero-value outputs are padding every scanner skips. */
    nonZeroCommitments: Hex32[];
    ownInflow: CircuitAmount;
}

/**
 * Commitments of `built`, split by ownership (`ownIndices`, the shuffled slots holding own notes).
 * Zero-value slots are dropped from the own and non-zero lists, since waiting on them would hang.
 */
export function outputCommitments(
    built: BuiltLike,
    ownIndices: readonly OutputSlot[],
): OutputCommitments {
    const commitments: Hex32[] = built.cm.map(fieldToBytes32);
    const valueAt = (i: OutputSlot): bigint => {
        const note = built.producedNotes[i];
        if (note === undefined) {
            throw new InternalError(
                `ownIndices names slot ${i}, which the bundle has no output for`,
            );
        }
        return BigInt(note.value);
    };
    const own = ownIndices.filter((i) => valueAt(i) > 0n);
    return {
        commitments,
        ownCommitments: own.map((i) => commitments[i]!),
        nonZeroCommitments: commitments.filter((_, i) => valueAt(i) > 0n),
        ownInflow: branded<CircuitAmount>(own.reduce((acc, i) => acc + valueAt(i), 0n)),
    };
}
