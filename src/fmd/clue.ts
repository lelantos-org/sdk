// Fuzzy Message Detection: FMD2 (Beck & Len, 2021), a.k.a. Niwl. Flagging and testing a clue.
//
// Scheme variant: lelantos.fmd.v1 (Poseidon + Legendre symbol). `FMD_DOMAIN` identifies the
// scheme; keys and clues interoperate only between matching domains.
//
// Sender flags a message for fk over a base point B, the `g_d` of the recipient's address:
//   r ← Z_q*
//   R = B · r
//   for i ∈ [γ]: bit_i = legendre_bit(Poseidon([TAG_FMD_BIT, R.x, R.y, i, S_i.x, S_i.y]))
//                S_i = r·X_i
//                c_i = bit_i ⊕ 1
//   clue = (R, c_1 || ... || c_γ)
//   where legendre_bit(h) = 1 iff h is a quadratic residue in 𝔽_r.
//
// Receiver tests with dk:
//   S_i = x_i · R
//   for i ∈ [γ]: bit_i = legendre_bit(Poseidon([TAG_FMD_BIT, R.x, R.y, i, S_i.x, S_i.y]))
//                if bit_i ⊕ c_i ≠ 1 → reject
//
// For the honest recipient r·X_i == x_i·R, so all γ checks pass. For anyone else each check is
// independently random: the false-positive rate is 2^-γ, 1/32 at the default γ = 5.
//
// Keys are in `./keys.ts`, their per-address expansion in `./diversified.ts`, the wire encodings
// in `./codec.ts`.

import { packBits, unpackBits } from "../core/bits.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR } from "../core/field.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { jacobiSymbol, legendreSymbol } from "../crypto/sqrt.js";
import { TAG_FMD_BIT } from "../crypto/tags.js";
import { assertInvariant } from "../errors/base.js";
import { InvalidArgumentError } from "../errors/config.js";
import type { FmdDetectionKey, FmdFlagKey } from "./keys.js";

/** @internal */
export const FMD_DOMAIN = "lelantos.fmd.v1";

/** @internal */
export interface FmdClue {
    R: Uint8Array;
    bits: Uint8Array;
    gamma: number;
}

/**
 * Flag a message for `fk` over the base point `base`: `R = r · base`, `S_i = r · X_i`.
 *
 * `fmdTest` accepts the clue under `x` when `fk.X[i] = x_i · base`. `base` and every `X_i` must be
 * in the prime-order subgroup and not the identity; neither is checked.
 *
 * @throws {InvalidArgumentError} when `r` is zero mod q.
 */
export function fmdFlagOnBase(
    J: Jubjub,
    P: Poseidon,
    fk: FmdFlagKey,
    base: Point,
    r: Field,
): FmdClue {
    const rMod = fmdFlagScalar(r);
    const R = J.mulPointEscalar(base, rMod);
    const shared = fk.X.map((Xi) => J.mulPointEscalar(Xi, rMod));
    return fmdClueFromShared(J, P, R, shared);
}

/**
 * The clue with point `R` and shared points `S_i`: `c_i = bit_i ⊕ 1`, γ the number of `S_i`.
 *
 * @internal
 */
export function fmdClueFromShared(
    J: Jubjub,
    P: Poseidon,
    R: Point,
    shared: readonly Point[],
): FmdClue {
    // A clue is built where the scalar behind every `S_i` is held, not by a remote detector, so
    // the faster symbol is used although its running time varies with the hash.
    const cBits = shared.map((Si, i) => fmdSharedBit(P, R, i, Si, jacobiSymbol) ^ 1);
    return { R: J.packPoint(R), bits: packBits(cBits), gamma: shared.length };
}

/**
 * The flag blinder as a subgroup scalar: `r mod q`.
 *
 * @throws {InvalidArgumentError} when it is zero.
 * @internal
 */
export function fmdFlagScalar(r: Field): Field {
    const rMod = r % BABYJUB_SUBGROUP_ORDER;
    if (rMod === 0n) {
        throw new InvalidArgumentError("fmd flag: r must be non-zero mod q", { argument: "r" });
    }
    return rMod;
}

/** @internal */
export function fmdTest(J: Jubjub, P: Poseidon, dk: FmdDetectionKey, clue: FmdClue): boolean {
    if (dk.x.length !== clue.gamma) return false;
    const R = J.unpackPoint(clue.R);
    if (!R || !J.inSubgroup(R)) return false;

    // Every index is evaluated, with no early exit on a mismatching bit. An early exit would
    // leak, through timing, the number of leading matching bits rather than only match/no-match,
    // which matters under delegated detection, where a remote server holds the `x_i`.
    //
    // The length and `R` checks above short-circuit: both depend only on public metadata.
    const cBits = unpackBits(clue.bits, clue.gamma);
    let matched = 1;
    for (let i = 0; i < clue.gamma; i++) {
        const x = dk.x[i];
        if (x === undefined) return false;
        const shared = J.mulPointEscalar(R, x);
        // Bitwise `&`, not `&&`: the loop must not become data-dependent. For the same reason the
        // symbol is `legendreSymbol`: one exponentiation by a fixed exponent, whatever the hash.
        matched &= fmdSharedBit(P, R, i, shared, legendreSymbol) ^ (cBits[i] ?? 0);
    }
    return matched === 1;
}

/**
 * Legendre-symbol bit of Poseidon([TAG_FMD_BIT, R.x, R.y, i, S.x, S.y]): 1 iff the hash is a
 * quadratic residue. Computed off-circuit by sender and detector alike.
 *
 * `symbol` is `legendreSymbol` or `jacobiSymbol`: `BN254_FR` is prime, so the two agree on every
 * hash and differ in running time only (`crypto/sqrt.ts`).
 */
function fmdSharedBit(
    P: Poseidon,
    R: Point,
    i: number,
    shared: Point,
    symbol: typeof legendreSymbol,
): number {
    const h = P.hash([TAG_FMD_BIT, R[0], R[1], BigInt(i), shared[0], shared[1]]);
    const sym = symbol(h, BN254_FR);
    assertInvariant(sym !== 0, "FMD shared bit: hash collided to zero");
    return sym === 1 ? 1 : 0;
}
