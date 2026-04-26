import type { Poseidon, Field } from "./poseidon";
import { TAG_NF } from "./tags";

// nf = Poseidon(TAG_NF, nsk, rho). Mirrors Nullifier in note.circom.
export function buildNullifier(P: Poseidon, nsk: Field, rho: Field): Field {
    return P.hash([TAG_NF, nsk, rho]);
}
