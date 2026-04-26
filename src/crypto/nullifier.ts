import { deriveNk } from "./derive.js";
import type { Field, Poseidon } from "./poseidon.js";
import { TAG_NF } from "./tags.js";

/** @internal */
// Mirrors Nullifier in note.circom: nf = Poseidon(TAG_NF, nk, rho, cm).
// Takes nk directly so FVK holders (nk without nsk) can recompute nullifiers.
// Use buildNullifierFromNsk for the spending-key path.
//
// `cm` is in the preimage so the nullifier identifies the exact note. Without
// it two notes sharing a rho share a nullifier, and spending either bricks the
// other — the faerie-gold attack. Deposit-path rho is caller-chosen and output
// rho is publicly derivable from nullifier[0], so rho alone is not safe to key
// on.
export function buildNullifier(P: Poseidon, nk: Field, rho: Field, cm: Field): Field {
    return P.hash([TAG_NF, nk, rho, cm]);
}

/** @internal */
// Convenience wrapper for spend paths that have nsk on hand.
export function buildNullifierFromNsk(P: Poseidon, nsk: Field, rho: Field, cm: Field): Field {
    return buildNullifier(P, deriveNk(P, nsk), rho, cm);
}
