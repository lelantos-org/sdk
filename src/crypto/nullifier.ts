import { deriveNk } from "./derive.js";
import type { Field, Poseidon } from "./poseidon.js";
import { TAG_NF } from "./tags.js";

/** @internal */
// Mirrors Nullifier in note.circom. Takes nk directly so FVK holders (nk without nsk) can
// recompute nullifiers. Use buildNullifierFromNsk for the spending-key path.
export function buildNullifier(P: Poseidon, nk: Field, rho: Field): Field {
    return P.hash([TAG_NF, nk, rho]);
}

/** @internal */
// Convenience wrapper for spend paths that have nsk on hand.
export function buildNullifierFromNsk(P: Poseidon, nsk: Field, rho: Field): Field {
    return buildNullifier(P, deriveNk(P, nsk), rho);
}
