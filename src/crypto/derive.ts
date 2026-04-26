import type { Poseidon, Field } from "./poseidon";
import { TAG_IVK, TAG_PK, TAG_DK } from "./tags";

export function deriveIvk(P: Poseidon, nsk: Field): Field {
    return P.hash([TAG_IVK, nsk]);
}

export function derivePkFromIvk(P: Poseidon, ivk: Field): Field {
    return P.hash([TAG_PK, ivk]);
}

export function derivePk(P: Poseidon, nsk: Field): Field {
    return derivePkFromIvk(P, deriveIvk(P, nsk));
}

// dk = Poseidon(TAG_DK, ivk). Off-circuit FMD detection key.
export function deriveDk(P: Poseidon, ivk: Field): Field {
    return P.hash([TAG_DK, ivk]);
}
