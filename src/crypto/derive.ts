import type { Field, Poseidon } from "./poseidon.js";
import { TAG_DK, TAG_IVK, TAG_NK, TAG_PK, TAG_SUB_TOKEN } from "./tags.js";

/** @internal */
export function deriveIvk(P: Poseidon, nsk: Field): Field {
    return P.hash([TAG_IVK, nsk]);
}

/**
 * `pk = Poseidon(TAG_PK, ivk, d)`: the commitment key of `ivk` under diversifier `d`. Mirrors
 * DerivePk in note.circom, which does not range-check `d`.
 *
 * @internal
 */
export function derivePkFromIvk(P: Poseidon, ivk: Field, d: Field): Field {
    return P.hash([TAG_PK, ivk, d]);
}

/** @internal */
export function derivePk(P: Poseidon, nsk: Field, d: Field): Field {
    return derivePkFromIvk(P, deriveIvk(P, nsk), d);
}

/** @internal */
// Off-circuit FMD root detection secret. Not published; an address carries
// `ck_d = (dk mod q) · g_d` instead (see `keys/diversified.ts`).
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
 * Off-circuit fmd-webserver subscription capability token. Derived rather than stored, so losing
 * local state does not lose the subscription.
 *
 * The input is `ivk`, not `dk`: any detection delegate can recover `dk`, since the γ scalars a
 * wallet POSTs are `x_i = dk + h_i` with public `h_i`, so a `dk`-derived token would be computable
 * by the server it authenticates against. `ivk` is secret and `dk = Poseidon(TAG_DK, ivk)` is
 * one-way.
 *
 * `epoch` makes the token rotatable. It is not secret but cannot be recovered from the server:
 * a read-only subscription lookup would be an existence oracle for tokens, and
 * `POST /v1/subscriptions` creates on miss, so probing for the current epoch re-attaches to a
 * rotated-away token or recreates a deleted one. At the default `epoch = 0` the token is a
 * function of `ivk` alone. After the first rotation the caller must persist the epoch: losing a
 * non-zero epoch requires a full re-backfill and strands the previous subscription.
 *
 * `epoch` is a `Field`: persist it as a plain number and pass `BigInt(n)`, since
 * `JSON.stringify` throws on bigint.
 */
export function deriveSubscriptionToken(P: Poseidon, ivk: Field, epoch: Field = 0n): Field {
    return P.hash([TAG_SUB_TOKEN, ivk, epoch]);
}
