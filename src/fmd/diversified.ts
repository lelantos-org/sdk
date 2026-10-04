// FMD over a diversified base. The scheme of `./clue.ts` with the address base `g_d` in place of
// Base8, and an expansion that does not depend on the receiver.
//
//   h_i = Poseidon(TAG_FMD_EXPAND2, i) mod q       global constants, i from 0
//   x_i = dk_root + h_i  (mod q)                   receiver; one detection key for every address
//   X_i = ck_d + h_i · g_d                         sender; from the address alone
//
// The sender flags for the address `(ck_d, g_d)` with `fmdFlagOnBase(fk, g_d, r)`, `r` in Z_q*:
//   R   = r · g_d
//   S_i = r · X_i
//   c_i = legendre_bit(Poseidon(TAG_FMD_BIT, R.x, R.y, i, S_i.x, S_i.y)) ⊕ 1
//
// `ck_d = dk_root · g_d`, so `X_i = x_i · g_d` and `r · X_i = x_i · R`: `fmdTest` accepts the clue
// under `x` for every `d`, with no knowledge of `d`.
//
// Preconditions. `g_d` and `ck_d` are in the prime-order subgroup and are not the identity; these
// functions do not check it.
//
// `h_i` is public, so any single `x_i` yields `dk_root = x_i - h_i` and every other `x_j`.

import { packBits } from "../core/bits.js";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { diversifiedBase } from "../crypto/diversified-base.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { TAG_FMD_EXPAND2 } from "../crypto/tags.js";
import { type FmdClue, fmdFlagScalar, fmdSharedBit } from "./clue.js";
import { FMD_DEFAULT_GAMMA, type FmdDetectionKey, type FmdFlagKey } from "./keys.js";

/**
 * `h_i = Poseidon(TAG_FMD_EXPAND2, i) mod q`.
 *
 * @internal
 */
export function fmdExpandScalar2(P: Poseidon, i: number): Field {
    return P.hash([TAG_FMD_EXPAND2, BigInt(i)]) % BABYJUB_SUBGROUP_ORDER;
}

/**
 * The γ detection scalars `x_i = dk_root + h_i (mod q)`. Receiver side.
 *
 * Independent of the diversifier: the same key tests clues for every address of `dk_root`.
 *
 * @internal
 */
export function fmdDiversifiedDetectionKey(
    P: Poseidon,
    dkRoot: Field,
    gamma = FMD_DEFAULT_GAMMA,
): FmdDetectionKey {
    const root = dkRoot % BABYJUB_SUBGROUP_ORDER;
    return {
        x: Array.from(
            { length: gamma },
            (_, i) => (root + fmdExpandScalar2(P, i)) % BABYJUB_SUBGROUP_ORDER,
        ),
    };
}

/**
 * The γ flag-key points `X_i = ck_d + h_i · g_d`. Sender side; requires no secret input.
 *
 * @internal
 */
export function fmdDiversifiedFlagKey(
    J: Jubjub,
    P: Poseidon,
    ckD: Point,
    gD: Point,
    gamma = FMD_DEFAULT_GAMMA,
): FmdFlagKey {
    return {
        X: Array.from({ length: gamma }, (_, i) =>
            J.addPoint(ckD, J.mulPointEscalar(gD, fmdExpandScalar2(P, i))),
        ),
    };
}

/**
 * The clue a sender produces for address `d` of `dkRoot` with blinder `r`. Receiver side.
 *
 * Equals `fmdFlagOnBase` on that address's flag key and `g_d`, computed as `S_i = x_i · R`. A
 * published clue that differs was not made for this address with this `r`.
 *
 * @throws {InvalidArgumentError} when `r` is zero mod q or `d` is not in `[0, 2^128)`.
 * @internal
 */
export function fmdExpectedClue(
    J: Jubjub,
    P: Poseidon,
    dkRoot: Field,
    d: Field,
    r: Field,
    gamma = FMD_DEFAULT_GAMMA,
): FmdClue {
    const rMod = fmdFlagScalar(r);
    const R = J.mulPointEscalar(diversifiedBase(J, P, d), rMod);
    const dk = fmdDiversifiedDetectionKey(P, dkRoot, gamma);
    const cBits = dk.x.map((xi, i) => fmdSharedBit(P, R, i, J.mulPointEscalar(R, xi)) ^ 1);
    return { R: J.packPoint(R), bits: packBits(cBits), gamma };
}
