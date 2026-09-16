// Fuzzy Message Detection: FMD2 (Beck & Len, 2021), a.k.a. Niwl. Flagging and testing a clue.
//
// Scheme variant: lelantos.fmd.v1 (Poseidon + Legendre symbol). bit = 1 iff
// the Poseidon output is a quadratic residue in 𝔽_r: ~4 in-circuit
// constraints/γ versus ~254 for Num2Bits, and uniform under Poseidon-as-RO.
// `FMD_DOMAIN` identifies the scheme; keys and clues interoperate only between
// matching domains. False-positive rate p = 2^-γ; default γ = 5 ⇒ 1/32.
//
// Sender flags a message for fk:
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
// For the honest recipient r·X_i == x_i·R, so all γ checks pass. For anyone
// else each check is independently random, giving acceptance probability 2^-γ.
//
// Keys are in `./keys.ts`, the wire encodings in `./codec.ts`.

import { packBits, unpackBits } from "../core/bits.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR } from "../core/field.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { legendreSymbol } from "../crypto/sqrt.js";
import { TAG_FMD_BIT } from "../crypto/tags.js";
import { assertInvariant } from "../errors/base.js";
import { InvalidArgumentError } from "../errors/config.js";
import type { FmdDetectionKey, FmdFlagKey } from "./keys.js";

/** @internal */
export const FMD_DOMAIN = "lelantos.fmd.v1";
// `TAG_FMD_BIT` is defined in `crypto/tags.ts`; it must match
// circuits/src/lib/tags.circom and backend/crates/crypto/src/clue.rs.

/** @internal */
export interface FmdClue {
    R: Uint8Array;
    bits: Uint8Array;
    gamma: number;
}

export function fmdFlag(J: Jubjub, P: Poseidon, fk: FmdFlagKey, r: Field): FmdClue {
    const gamma = fk.X.length;
    const rMod = r % BABYJUB_SUBGROUP_ORDER;
    if (rMod === 0n) {
        throw new InvalidArgumentError("fmd flag: r must be non-zero mod q", { argument: "r" });
    }

    const R = J.mulPointEscalar(J.base8, rMod);
    const Rpacked = J.packPoint(R);

    const cBits = fk.X.map((Xi, i) => {
        const shared = J.mulPointEscalar(Xi, rMod);
        return sharedBit(P, R, i, shared) ^ 1;
    });

    return { R: Rpacked, bits: packBits(cBits), gamma };
}

/** @internal */
export function fmdTest(J: Jubjub, P: Poseidon, dk: FmdDetectionKey, clue: FmdClue): boolean {
    if (dk.x.length !== clue.gamma) return false;
    const R = J.unpackPoint(clue.R);
    if (!R || !J.inSubgroup(R)) return false;

    // Every index is evaluated, with no early exit on a mismatching bit.
    //
    // Each iteration costs a Baby-Jubjub scalar multiplication plus a 254-bit
    // Legendre exponentiation, which dominates and is measurable. An early exit
    // would leak the number of leading matching bits rather than only the
    // match/no-match result, which matters in the delegated-detection model
    // where the `x_i` scalars are held by a remote server.
    //
    // The `dk.x.length !== clue.gamma` and `R` checks above short-circuit:
    // both depend only on public metadata, not the key.
    const cBits = unpackBits(clue.bits, clue.gamma);
    let matched = 1;
    for (let i = 0; i < clue.gamma; i++) {
        const x = dk.x[i];
        if (x === undefined) return false;
        const shared = J.mulPointEscalar(R, x);
        // Bitwise `&`, not `&&`: the loop must not become data-dependent.
        matched &= sharedBit(P, R, i, shared) ^ (cBits[i] ?? 0);
    }
    return matched === 1;
}

// Legendre-symbol bit of Poseidon([TAG_FMD_BIT, R.x, R.y, i, S.x, S.y]).
// Same six-input layout as the in-circuit `ClueCheck` (bit=1 ⟺ QR).
function sharedBit(P: Poseidon, R: Point, i: number, shared: Point): number {
    const h = P.hash([TAG_FMD_BIT, R[0], R[1], BigInt(i), shared[0], shared[1]]);
    const sym = legendreSymbol(h, BN254_FR);
    assertInvariant(sym !== 0, "FMD shared bit: hash collided to zero");
    return sym === 1 ? 1 : 0;
}
