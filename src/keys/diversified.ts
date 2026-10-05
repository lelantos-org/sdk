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
import {
    assertDiversifier,
    DIVERSIFIER_BOUND,
    diversifiedBase,
} from "../crypto/diversified-base.js";
import { type Jubjub, type Point, samePoint } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";

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
 */
export function deriveDiversifiedPk(P: Poseidon, ivk: Field, d: Field): Field {
    assertDiversifier(d);
    return derivePkFromIvk(P, ivk, d);
}

/**
 * The FMD root detection secret as a subgroup scalar: `Poseidon(TAG_DK, ivk) mod q`.
 *
 * @throws {InvalidArgumentError} when the result is zero, which would make every `ck_d` the
 * identity.
 */
export function deriveDkRoot(P: Poseidon, ivk: Field): Field {
    return nonZeroScalar(deriveDk(P, ivk), "dk_root");
}

/**
 * Every key of the address `(ivk, d)`.
 *
 * @throws {InvalidArgumentError} when `d` is not in `[0, 2^128)`, or when `ivk mod q` or
 * `dk_root` is zero: either makes a published key the identity.
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

/**
 * Whether `a` is the address of `ivk` at diversifier `a.d`: `pk`, `pk_d` and `ck_d` all equal the
 * keys `ivk` derives for `a.d`.
 *
 * A note sent to the address is committed under `pk`, encrypted to `pk_d` and flagged under
 * `ck_d`; the account receives it only when all three are its own. A `d` outside `[0, 2^128)`
 * belongs to no address and yields `false`.
 *
 * @throws {InvalidArgumentError} when `ivk` is not canonical, or `ivk mod q` or `dk_root` is zero.
 */
export function ownsAddress(
    P: Poseidon,
    J: Jubjub,
    ivk: Field,
    a: Pick<DiversifiedKeys, "d" | "pk" | "pk_d" | "ck_d">,
): boolean {
    if (a.d < 0n || a.d >= DIVERSIFIER_BOUND) return false;
    const own = buildDiversifiedKeys(P, J, ivk, a.d);
    return own.pk === a.pk && samePoint(own.pk_d, a.pk_d) && samePoint(own.ck_d, a.ck_d);
}

/**
 * Reject a secret that is zero mod q. `what` names it in the message; the argument reported is
 * `ivk`, of which every such secret is a function.
 *
 * @internal
 */
export function assertNonZeroModQ(secret: Field, what: string): void {
    if (secret % BABYJUB_SUBGROUP_ORDER === 0n) {
        throw new InvalidArgumentError(`${what} must be non-zero mod q`, { argument: "ivk" });
    }
}

/** `secret mod q`, rejecting zero. */
function nonZeroScalar(secret: Field, what: string): Field {
    assertNonZeroModQ(secret, what);
    return secret % BABYJUB_SUBGROUP_ORDER;
}
