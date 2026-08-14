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
 * The input is `ivk`, not `dk`. Any detection delegate can recover `dk`: the γ
 * scalars a wallet POSTs are `x_i = dk + h_i`, and `h_i` follows from the
 * public `ck`. A `dk`-derived token would therefore be computable by the server
 * it authenticates against. `ivk` is secret and `dk = Poseidon(TAG_DK, ivk)` is
 * one-way, so a token derived from `ivk` is not.
 *
 * `epoch` makes the token rotatable; without it the token is a pure function
 * of an identity the wallet cannot change. The token is a bearer credential
 * sent on every poll, so bumping `epoch` derives a replacement under the same
 * identity.
 *
 * The epoch is not a secret, but it cannot be recovered from the server, and
 * the caller must persist it once it is non-zero. There is no read-only
 * subscription lookup — deliberately, since one would be an existence oracle
 * for tokens — and `POST /v1/subscriptions` creates on miss, so probing for
 * the current epoch is a write that fails both ways: it either re-attaches to
 * the token being rotated away from, or recreates one that a rotation deleted.
 *
 * At the default `epoch = 0` there is nothing to persist; the token is a pure
 * function of `ivk`. The obligation starts on the first rotation. Losing a
 * non-zero epoch does not lose the wallet — register a fresh one and the
 * indexer backfills — but it costs a full re-backfill and strands the previous
 * subscription, which can no longer be deleted because its token is
 * unrecoverable.
 *
 * `epoch` is a `Field`, so a caller persisting it should store a plain number
 * and pass `BigInt(n)`; `JSON.stringify` throws on bigint.
 */
export function deriveSubscriptionToken(P: Poseidon, ivk: Field, epoch: Field = 0n): Field {
    return P.hash([TAG_SUB_TOKEN, ivk, epoch]);
}
