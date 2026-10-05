// FMD keys of a diversified address: the scheme of `./clue.ts` on the address base `B = g_d`, with
// both γ-component keys expanded from one scalar.
//
//   dk_root ∈ Z_q                                 root secret, never published
//   ck_d = dk_root · g_d                          clue key, published in the address
//   h_i  = Poseidon(TAG_FMD_EXPAND2, i) mod q     public constants, i from 0, the same for everyone
//   x_i  = dk_root + h_i  (mod q)                 receiver; one detection key for every address
//   X_i  = ck_d + h_i · g_d                       sender; from the address alone
//
// `X_i = x_i · g_d`, so a clue flagged on `g_d` has `r · X_i = x_i · R`: `fmdTest` accepts it
// under `x` for every `d`, with no knowledge of `d`. Recovering `x_i` from `ck_d` is a discrete
// log, so an address allows flagging for its recipient, not detecting for them.
//
// `h_i` is public, so any single `x_i` yields `dk_root = x_i - h_i` and every other `x_j`.
// Detection delegation is all-or-nothing, non-revocable, and cannot be precision-bounded.
//
// Preconditions. `g_d` and `ck_d` are in the prime-order subgroup and are not the identity; these
// functions do not check it.

import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { diversifiedBase } from "../crypto/diversified-base.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { TAG_FMD_EXPAND2 } from "../crypto/tags.js";
import { type FmdClue, fmdClueFromShared, fmdFlagScalar } from "./clue.js";
import { FMD_DEFAULT_GAMMA, type FmdDetectionKey, type FmdFlagKey } from "./keys.js";

/**
 * `h_i = Poseidon(TAG_FMD_EXPAND2, i) mod q`.
 *
 * @internal
 */
export function fmdExpansionScalar(P: Poseidon, i: number): Field {
    return P.hash([TAG_FMD_EXPAND2, BigInt(i)]) % BABYJUB_SUBGROUP_ORDER;
}

/**
 * The γ detection scalars `x_i = dk_root + h_i (mod q)`. Receiver side.
 *
 * Independent of the diversifier: the same key tests clues for every address of `dk_root`.
 *
 * A zero `x_i` is kept as is: the sender's `X_i` is then the identity and both sides compute the
 * same constant bit. `gamma` is not checked; callers enforce the ceiling with
 * `assertDetectionGamma`.
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
            (_, i) => (root + fmdExpansionScalar(P, i)) % BABYJUB_SUBGROUP_ORDER,
        ),
    };
}

/** The γ flag-key points `X_i = ck_d + h_i · g_d`. Sender side; requires no secret input. */
export function fmdDiversifiedFlagKey(
    J: Jubjub,
    P: Poseidon,
    ckD: Point,
    gD: Point,
    gamma = FMD_DEFAULT_GAMMA,
): FmdFlagKey {
    return {
        X: Array.from({ length: gamma }, (_, i) =>
            J.addPoint(ckD, J.mulPointEscalar(gD, fmdExpansionScalar(P, i))),
        ),
    };
}

/**
 * The clue a sender produces with blinder `r` on base `gD`, computed from the detection key.
 *
 * Equals `fmdFlagOnBase` on the flag key `X_i = x_i · gD`, computed as `S_i = x_i · R`. γ is
 * `dk.x.length`.
 *
 * @throws {InvalidArgumentError} when `r` is zero mod q.
 * @internal
 */
export function fmdExpectedClueOnBase(
    J: Jubjub,
    P: Poseidon,
    dk: FmdDetectionKey,
    gD: Point,
    r: Field,
): FmdClue {
    const R = J.mulPointEscalar(gD, fmdFlagScalar(r));
    const shared = dk.x.map((xi) => J.mulPointEscalar(R, xi));
    return fmdClueFromShared(J, P, R, shared);
}

/**
 * The clue a sender produces for address `d` of `dkRoot` with blinder `r`. Receiver side.
 *
 * A published clue that differs was not made for this address with this `r`.
 *
 * @throws {InvalidArgumentError} when `r` is zero mod q or `d` is not in `[0, 2^128)`.
 */
export function fmdExpectedClue(
    J: Jubjub,
    P: Poseidon,
    dkRoot: Field,
    d: Field,
    r: Field,
    gamma = FMD_DEFAULT_GAMMA,
): FmdClue {
    // `r` is rejected ahead of `d`.
    const rMod = fmdFlagScalar(r);
    const gD = diversifiedBase(J, P, d);
    return fmdExpectedClueOnBase(J, P, fmdDiversifiedDetectionKey(P, dkRoot, gamma), gD, rMod);
}
