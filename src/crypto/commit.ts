import type { Poseidon, Field } from "./poseidon";
import { POW_2_64 } from "./tags";

export interface NoteCommitInput {
    asset: Field;
    value: Field;
    pk: Field;
    rho: Field;
    rcm: Field;
}

// cm = Poseidon(asset·2^64 + value, pk, rho, rcm). Arity-4, no tag —
// arity + (asset, value) packing already provide domain separation.
// Mirrors NoteCommitment in circuits/src/lib/note.circom.
//
// Soundness requires asset_id < 2^64 and value < 2^64; the circuit
// range-checks both. Caller responsibility off-circuit.
export function buildNoteCommitment(P: Poseidon, n: NoteCommitInput): Field {
    if (n.asset >= POW_2_64) throw new Error("asset must fit in 64 bits");
    if (n.value >= POW_2_64) throw new Error("value must fit in 64 bits");
    const packedAv = n.asset * POW_2_64 + n.value;
    return P.hash([packedAv, n.pk, n.rho, n.rcm]);
}
