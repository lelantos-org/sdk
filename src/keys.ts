// Spending key hierarchy.
//
//   nsk  (root, never leaves owner)
//    └─ ivk  = Poseidon(TAG_IVK, nsk)
//        ├─ pk    = Poseidon(TAG_PK, ivk)        — scalar, binds note commitment
//        ├─ pk_d  = (ivk mod q) · Base8          — Baby-Jubjub key, used for ECDH
//        └─ dk    = Poseidon(TAG_DK, ivk)        — FMD detection-key seed
//
// `pk` (in the circuit) and `pk_d` (in the address) intentionally differ:
// the circuit binds the scalar `pk` into every commitment, while the
// address publishes the group element `pk_d` so senders can derive a
// shared secret without learning ivk.

import {
    Poseidon,
    Jubjub,
    deriveIvk,
    derivePkFromIvk,
    deriveDk,
    BABYJUB_SUBGROUP_ORDER,
    type Field,
    type Point,
} from "./crypto/index";

export interface SpendingKey {
    nsk: Field;
    ivk: Field;
    pk: Field;
    pk_d: Point;
    dk: Field;
}

// Sufficient to trial-decrypt and detect; NOT to spend.
export interface ViewingKey {
    ivk: Field;
    pk_d: Point;
    dk: Field;
}

export function buildSpendingKey(P: Poseidon, J: Jubjub, nsk: Field): SpendingKey {
    const ivk = deriveIvk(P, nsk);
    return {
        nsk,
        ivk,
        pk: derivePkFromIvk(P, ivk),
        pk_d: J.mulPointEscalar(J.base8, ivk % BABYJUB_SUBGROUP_ORDER),
        dk: deriveDk(P, ivk),
    };
}

export function viewingKeyFromSpending(sk: SpendingKey): ViewingKey {
    return { ivk: sk.ivk, pk_d: sk.pk_d, dk: sk.dk };
}
