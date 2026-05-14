import type { Field, Poseidon } from "./poseidon.js";
import { TAG_DK, TAG_IVK, TAG_NK, TAG_PK } from "./tags.js";

export function deriveIvk(P: Poseidon, nsk: Field): Field {
    return P.hash([TAG_IVK, nsk]);
}

export function derivePkFromIvk(P: Poseidon, ivk: Field): Field {
    return P.hash([TAG_PK, ivk]);
}

export function derivePk(P: Poseidon, nsk: Field): Field {
    return derivePkFromIvk(P, deriveIvk(P, nsk));
}

// Off-circuit FMD detection key.
export function deriveDk(P: Poseidon, ivk: Field): Field {
    return P.hash([TAG_DK, ivk]);
}

// Mirrors DeriveNk in note.circom. FVK component: nk holder can recompute nf for any
// known rho without nsk.
export function deriveNk(P: Poseidon, nsk: Field): Field {
    return P.hash([TAG_NK, nsk]);
}
