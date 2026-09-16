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
// Off-circuit FMD root detection secret. Not published; the address carries
// `ck = dk · Base8` instead (see `fmdClueKeyFromRoot`).
export function deriveDk(P: Poseidon, ivk: Field): Field {
    return P.hash([TAG_DK, ivk]);
}

/** @internal */
// Mirrors DeriveNk in note.circom. FVK component: an nk holder can recompute nf for any known rho
// without nsk.
export function deriveNk(P: Poseidon, nsk: Field): Field {
    return P.hash([TAG_NK, nsk]);
}

/**
 * Off-circuit fmd-webserver subscription capability token.
 *
 * Derived rather than stored, so losing local state does not lose the subscription.
 *
 * The input is `ivk`, not `dk`. Any detection delegate can recover `dk`: the γ scalars a wallet
 * POSTs are `x_i = dk + h_i`, and `h_i` follows from the public `ck`, so a `dk`-derived token
 * would be computable by the server it authenticates against. `ivk` is secret and
 * `dk = Poseidon(TAG_DK, ivk)` is one-way.
 *
 * `epoch` makes the token rotatable. It is not secret but cannot be recovered from the server:
 * there is no read-only subscription lookup (it would be an existence oracle for tokens), and
 * `POST /v1/subscriptions` creates on miss. Probing for the current epoch is therefore a write
 * that either re-attaches to the token being rotated away from or recreates a deleted one.
 *
 * At the default `epoch = 0` the token is a pure function of `ivk`. After the first rotation the
 * caller must persist the epoch; losing a non-zero epoch requires a full re-backfill and strands
 * the previous subscription, whose token is then unrecoverable.
 *
 * `epoch` is a `Field`: persist it as a plain number and pass `BigInt(n)`,
 * since `JSON.stringify` throws on bigint.
 */
export function deriveSubscriptionToken(P: Poseidon, ivk: Field, epoch: Field = 0n): Field {
    return P.hash([TAG_SUB_TOKEN, ivk, epoch]);
}
