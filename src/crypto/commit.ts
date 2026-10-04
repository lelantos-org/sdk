import { assertU64, POW_2_64 } from "../core/field.js";
import type { Field, Poseidon } from "./poseidon.js";
import { TAG_CM, TAG_INNER } from "./tags.js";

/** @internal */
export interface NoteCommitInput {
    asset: Field;
    value: Field;
    pk: Field;
    rho: Field;
    rcm: Field;
}

/**
 * inner = Poseidon(TAG_INNER, pk, rho, rcm). Mirrors NoteInner in circuits/src/lib/note.circom.
 * A deposit publishes it beside its public (asset, value); `rcm` is the only secret in it.
 *
 * @internal
 */
export function buildInner(P: Poseidon, n: { pk: Field; rho: Field; rcm: Field }): Field {
    return P.hash([TAG_INNER, n.pk, n.rho, n.rcm]);
}

/**
 * cm = Poseidon(TAG_CM, asset·2^64 + value, inner): the form tree_update_batch computes for a
 * deposit leaf. Soundness requires asset < 2^64 and value < 2^64; the circuit range-checks both.
 *
 * @internal
 */
export function commitWithInner(P: Poseidon, asset: Field, value: Field, inner: Field): Field {
    // Lower bound too: a negative `asset` or `value` makes the packed word negative, which the
    // circuit's range check rejects. `P.hash` checks `inner`.
    assertU64(asset, "asset");
    assertU64(value, "value");
    return P.hash([TAG_CM, asset * POW_2_64 + value, inner]);
}

/**
 * cm = Poseidon(TAG_CM, asset·2^64 + value, Poseidon(TAG_INNER, pk, rho, rcm)). Mirrors
 * NoteInner + NoteCommitment in circuits/src/lib/note.circom. cm is the commitment-tree leaf.
 */
export function buildNoteCommitment(P: Poseidon, n: NoteCommitInput): Field {
    return commitWithInner(P, n.asset, n.value, buildInner(P, n));
}
