// Keys of one diversified address. For a viewing key `ivk` and diversifier `d`:
//
//   g_d     = diversifiedBase(d)                 public, a function of d alone
//   pk      = Poseidon(TAG_PK, ivk, d)           scalar, binds the note commitment
//   pk_d    = (ivk mod q) · g_d                  ECDH target
//   dk_root = Poseidon(TAG_DK, ivk) mod q        FMD root detection secret, the same for every d
//   ck_d    = dk_root · g_d                      FMD clue key
//
// An address publishes `(d, pk, pk_d, ck_d)`. The holder of `ivk` recomputes all of it from `d`.
//
// `pk_d` and `ck_d` are multiples of `g_d`, so ECDH and clue arithmetic for the address run on
// `g_d` (`esk · g_d`, `r · g_d`).

import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { deriveDk, derivePkFromIvk } from "../crypto/derive.js";
import { assertDiversifier, diversifiedBase } from "../crypto/diversified-base.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";
import { defaultDiversifier } from "./diversifier.js";

/** @internal */
export interface DiversifiedKeys {
    /** The diversifier as an integer in `[0, 2^128)`. */
    d: Field;
    /** Base point of the address. In the prime-order subgroup, never the identity. */
    g_d: Point;
    /** `Poseidon(TAG_PK, ivk, d)`. */
    pk: Field;
    /** `(ivk mod q) · g_d`. */
    pk_d: Point;
    /** `dk_root · g_d`. */
    ck_d: Point;
}

/**
 * The commitment key of address `d`: `Poseidon(TAG_PK, ivk, d)`, arity 3.
 *
 * @throws {InvalidArgumentError} when `d` is not in `[0, 2^128)` or `ivk` is not canonical.
 * @internal
 */
export function deriveDiversifiedPk(P: Poseidon, ivk: Field, d: Field): Field {
    assertDiversifier(d);
    return derivePkFromIvk(P, ivk, d);
}

/**
 * The commitment key of the account's default address: `Poseidon(TAG_PK, ivk, d0)` with
 * `d0 = defaultDiversifier(ivk)`. Every note the account owns is committed under it.
 *
 * @throws {InvalidArgumentError} when `ivk` is not canonical.
 * @internal
 */
export function deriveDefaultPk(P: Poseidon, ivk: Field): Field {
    return deriveDiversifiedPk(P, ivk, defaultDiversifier(ivk));
}

/**
 * The FMD root detection secret as a subgroup scalar: `Poseidon(TAG_DK, ivk) mod q`.
 *
 * @throws {InvalidArgumentError} when the result is zero, which would make every `ck_d` the
 * identity.
 * @internal
 */
export function deriveDkRoot(P: Poseidon, ivk: Field): Field {
    return nonZeroScalar(deriveDk(P, ivk), "dk_root");
}

/**
 * Every key of the address `(ivk, d)`.
 *
 * @throws {InvalidArgumentError} when `d` is not in `[0, 2^128)`, or when `ivk mod q` or
 * `dk_root` is zero: either makes a published key the identity.
 * @internal
 */
export function buildDiversifiedKeys(
    P: Poseidon,
    J: Jubjub,
    ivk: Field,
    d: Field,
): DiversifiedKeys {
    const pk = deriveDiversifiedPk(P, ivk, d);
    const ivkScalar = nonZeroScalar(ivk, "ivk");
    const dkRoot = deriveDkRoot(P, ivk);
    const g_d = diversifiedBase(J, P, d);
    return {
        d,
        g_d,
        pk,
        pk_d: J.mulPointEscalar(g_d, ivkScalar),
        ck_d: J.mulPointEscalar(g_d, dkRoot),
    };
}

/** `secret mod q`, rejecting zero. `what` names the secret, which is a function of `ivk`. */
function nonZeroScalar(secret: Field, what: string): Field {
    const scalar = secret % BABYJUB_SUBGROUP_ORDER;
    if (scalar === 0n) {
        throw new InvalidArgumentError(`${what} must be non-zero mod q`, { argument: "ivk" });
    }
    return scalar;
}
