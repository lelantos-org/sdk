import type { Field, Poseidon } from "./poseidon.js";
import { TAG_RHO } from "./tags.js";

/** @internal */
// Mirrors DeriveRho in circuits/src/lib/note.circom. Output-note rho is bound to
// the first input nullifier (chain-unique) + output index, so no two committed
// output notes can share a rho — the Orchard-style faerie-gold defense.
export function buildRho(P: Poseidon, nf0: Field, index: number | bigint): Field {
    return P.hash([TAG_RHO, nf0, BigInt(index)]);
}
