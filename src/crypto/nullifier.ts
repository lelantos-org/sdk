import { deriveNk } from "./derive.js";
import type { Field, Poseidon } from "./poseidon.js";
import { TAG_NF } from "./tags.js";

// nf = Poseidon(TAG_NF, nk, rho). Mirrors Nullifier in note.circom.
// Takes nk directly so FVK holders (who have nk but not nsk) can recompute
// nullifiers. Use buildNullifierFromNsk for the spending-key path.
export function buildNullifier(P: Poseidon, nk: Field, rho: Field): Field {
    return P.hash([TAG_NF, nk, rho]);
}

// Convenience wrapper for spend paths that have nsk on hand. Derives nk
// then hashes; identical output to deriving nk explicitly.
export function buildNullifierFromNsk(P: Poseidon, nsk: Field, rho: Field): Field {
    return buildNullifier(P, deriveNk(P, nsk), rho);
}
