// Diversified base point: a Baby-Jubjub subgroup generator derived from a diversifier `d`.
//
//   for ctr in 0..255:
//     y   = Poseidon(TAG_GD, d, ctr)
//     P0  = unpackPoint(LE32(y))        skip ctr if it does not decode
//     G   = [8]·P0
//     if G ≠ identity: return G
//
// `y < BN254_FR < 2^254`, so bit 255 of `LE32(y)` (the packed sign bit) is clear and `P0` is the
// point with ordinate `y` whose abscissa is at most `(p - 1) / 2`. `[8]` clears the cofactor, so
// `G` is in the prime-order subgroup. About half of all `y` are the ordinate of a curve point.
//
// Decoder parity. `unpackPoint` rejects `y = ±1` (the identity and the order-2 point, `x = 0`). A
// decoder that accepts them reaches `[8]·P0 = identity` and skips the same counter, so both agree
// on `G` provided the identity check is kept.

import { toLeBytes } from "../core/bytes.js";
import { assertRange } from "../core/field.js";
import { InternalError } from "../errors/base.js";
import type { Jubjub, Point } from "./jubjub.js";
import type { Field, Poseidon } from "./poseidon.js";
import { TAG_GD } from "./tags.js";

/** @internal */
export const DIVERSIFIER_BYTES = 16;

/**
 * Exclusive upper bound of a diversifier read as an integer: `2^128`.
 *
 * @internal
 */
export const DIVERSIFIER_BOUND = 1n << BigInt(DIVERSIFIER_BYTES * 8);

/** Counters tried before giving up. All failing has probability ~`2^-256`. */
const GD_COUNTERS = 256;

const COFACTOR = 8n;

/**
 * A diversifier as an integer: `[0, 2^128)`.
 *
 * @throws {InvalidArgumentError} otherwise.
 * @internal
 */
export function assertDiversifier(d: Field, what = "d"): void {
    assertRange(d, 0n, DIVERSIFIER_BOUND, what, "a 16-byte diversifier in [0, 2^128)");
}

/** @internal */
export interface DiversifiedBase {
    /** `g_d`: in the prime-order subgroup, never the identity. */
    g_d: Point;
    /** The first counter whose candidate decodes to a point outside the 8-torsion. */
    ctr: number;
}

/**
 * `g_d` together with the counter that produced it.
 *
 * @throws {InvalidArgumentError} when `d` is not in `[0, 2^128)`.
 * @internal
 */
export function findDiversifiedBase(J: Jubjub, P: Poseidon, d: Field): DiversifiedBase {
    assertDiversifier(d);
    for (let ctr = 0; ctr < GD_COUNTERS; ctr++) {
        const y = P.hash([TAG_GD, d, BigInt(ctr)]);
        const p0 = J.unpackPoint(toLeBytes(y));
        if (!p0) continue;
        const g = J.mulPointEscalar(p0, COFACTOR);
        if (g[0] === 0n && g[1] === 1n) continue;
        return { g_d: g, ctr };
    }
    throw new InternalError("diversified base: no counter in [0, 256) yields a point");
}

/**
 * The base point `g_d` of the address with diversifier `d`.
 *
 * A function of `d` alone, so a sender computes it from the address.
 *
 * @throws {InvalidArgumentError} when `d` is not in `[0, 2^128)`.
 * @internal
 */
export function diversifiedBase(J: Jubjub, P: Poseidon, d: Field): Point {
    return findDiversifiedBase(J, P, d).g_d;
}
