import type { Field, Poseidon } from "./poseidon.js";
import { TAG_DK, TAG_IVK, TAG_NK, TAG_PK, TAG_SUB_TOKEN } from "./tags.js";

/** @internal */
export function deriveIvk(P: Poseidon, nsk: Field): Field {
    return P.hash([TAG_IVK, nsk]);
}

/** @internal */
export function derivePkFromIvk(P: Poseidon, ivk: Field): Field {
    return P.hash([TAG_PK, ivk]);
}

/** @internal */
export function derivePk(P: Poseidon, nsk: Field): Field {
    return derivePkFromIvk(P, deriveIvk(P, nsk));
}

/** @internal */
// Off-circuit FMD detection key.
export function deriveDk(P: Poseidon, ivk: Field): Field {
    return P.hash([TAG_DK, ivk]);
}

/** @internal */
// Mirrors DeriveNk in note.circom. FVK component: nk holder can recompute nf for any
// known rho without nsk.
export function deriveNk(P: Poseidon, nsk: Field): Field {
    return P.hash([TAG_NK, nsk]);
}

/**
 * Off-circuit fmd-webserver subscription capability token.
 *
 * Deriving it leaves a wallet with no extra secret to persist: losing local
 * state costs a re-derivation, not the subscription.
 *
 * The input is `ivk`, not `dk`. `dk` is public in the bech32m address, and
 * the γ detection scalars the wallet POSTs are an additive counter stream off
 * it (`flagKeyFromAddressDk`) and so invert back to it, which would make a
 * `dk`-derived token computable by every sender. `ivk` is secret, and
 * `dk = Poseidon(TAG_DK, ivk)` is one-way.
 *
 * `epoch` makes the token rotatable; without it the token is a pure function
 * of an identity the wallet cannot change. The token is a bearer credential
 * sent on every poll, so bumping `epoch` derives a replacement under the same
 * identity. The epoch is not itself a secret: a wallet re-registers from
 * epoch 0 upward and reads `created` to locate the current one.
 */
export function deriveSubscriptionToken(P: Poseidon, ivk: Field, epoch: Field = 0n): Field {
    return P.hash([TAG_SUB_TOKEN, ivk, epoch]);
}
