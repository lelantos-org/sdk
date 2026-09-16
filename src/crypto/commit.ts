import { assertU64, POW_2_64 } from "../core/field.js";
import type { Field, Poseidon } from "./poseidon.js";

/** @internal */
export interface NoteCommitInput {
    asset: Field;
    value: Field;
    pk: Field;
    rho: Field;
    rcm: Field;
}

// cm = Poseidon(asset·2^64 + value, pk, rho, rcm). Arity-4 with no tag; arity and the
// (asset, value) packing provide domain separation. Mirrors NoteCommitment in
// circuits/src/lib/note.circom. Soundness requires asset_id < 2^64 and value < 2^64 (range-checked
// in the circuit; the caller's responsibility off-circuit).

export function buildNoteCommitment(P: Poseidon, n: NoteCommitInput): Field {
    // Lower bound too: a negative `asset` or `value` makes `packedAv` negative, which the circuit's
    // range check rejects. `P.hash` checks `pk`/`rho`/`rcm`.
    assertU64(n.asset, "asset");
    assertU64(n.value, "value");
    const packedAv = n.asset * POW_2_64 + n.value;
    return P.hash([packedAv, n.pk, n.rho, n.rcm]);
}
