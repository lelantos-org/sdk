// Fuzzy Message Detection — FMD2 (Beck & Len, 2021), a.k.a. Niwl.
//
// Scheme variant: lelantos.fmd.v4 (Poseidon + Legendre symbol). bit = 1 iff
// the Poseidon output is a quadratic residue in 𝔽_r — ~4 in-circuit
// constraints/γ against ~254 for Num2Bits, and uniform under Poseidon-as-RO.
// `FMD_DOMAIN` identifies the scheme; keys and clues interoperate only between
// matching domains. False-positive rate p = 2^-γ; default γ = 5 ⇒ 1/32.
//
// Receiver keys:
//   detection key   dk = (x_1, ..., x_γ) ∈ Z_q^γ
//   flag key        fk = (X_1, ..., X_γ) where X_i = B · x_i
//
// Key expansion. Both γ-component keys are derived on demand from a single
// scalar; only the public half appears in an address:
//
//   root secret  dk_root ∈ Z_q          never published
//   clue key     ck = B · dk_root       published (32 B, packed) in the address
//   h_i = Poseidon(TAG_FMD_EXPAND, ck.x, ck.y, i) mod q     public
//   x_i = dk_root + h_i  (mod q)        recipient; requires dk_root
//   X_i = ck + B · h_i                  sender; computable from ck alone
//
// X_i = (dk_root + h_i)·B = x_i·B, and recovering x_i from ck is a discrete
// log on Baby-Jubjub. Publishing `ck` therefore grants the ability to flag for
// a recipient, not to detect for them. Follows Penumbra's S-FMD
// ClueKey/DetectionKey split (additive derivation, `decaf377-fmd::hkd`) over
// Baby-Jubjub + Poseidon.
//
// Because `h_i` is public, a delegate holding any single `x_i` recovers
// dk_root = x_i - h_i and hence every other x_i. Detection delegation is
// therefore all-or-nothing and cannot be revoked or precision-bounded.
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
// Wire format, locked against the Rust indexer by deterministic vectors:
//   encoded clue = γ (1B) || R_packed (32B) || c_bits (⌈γ/8⌉ B, LSB-first)

import { packBits, unpackBits } from "../core/bits.js";
import { WireFormatError } from "../core/errors.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR } from "../core/field.js";
import { bytesToBareHex } from "../core/hex.js";
// Leaf imports, not the barrel: keeps the worker bundle minimal.
import { FIELD_BYTES, toLeBytes } from "../crypto/bytes.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { legendreSymbol } from "../crypto/sqrt.js";
import { TAG_FMD_BIT, TAG_FMD_EXPAND } from "../crypto/tags.js";

export const FMD_DEFAULT_GAMMA = 5;
/** @internal */
export const FMD_DOMAIN = "lelantos.fmd.v4";
// `TAG_FMD_BIT` is single-sourced in `crypto/tags.ts` alongside the rest of
// the table; it must match circuits/src/lib/tags.circom and
// backend/crates/fmd-crypto/src/clue.rs.

export interface FmdDetectionKey {
    x: Field[];
}
export interface FmdFlagKey {
    X: Point[];
}
/** @internal */
export interface FmdClue {
    R: Uint8Array;
    bits: Uint8Array;
    gamma: number;
}

/**
 * Encode a `FmdDetectionKey` as the `γ * 32`-byte little-endian blob the
 * fmd-webserver subscription endpoint expects. Each scalar is reduced
 * mod `BABYJUB_SUBGROUP_ORDER` then serialized LE-32. Matches the
 * `Buffer::concat` over `to_le_bytes()` encoding on the rust side.
 *
 * @internal
 */
export function detectionKeyToBytes(dk: FmdDetectionKey): Uint8Array {
    const out = new Uint8Array(dk.x.length * FIELD_BYTES);
    for (let i = 0; i < dk.x.length; i++) {
        out.set(toLeBytes(dk.x[i]! % BABYJUB_SUBGROUP_ORDER, FIELD_BYTES), i * FIELD_BYTES);
    }
    return out;
}

/**
 * Hex-encode a detection key for transport (no `0x` prefix — that's what
 * the server expects on `POST /v1/subscriptions`).
 */
export function detectionKeyToHex(dk: FmdDetectionKey): string {
    return bytesToBareHex(detectionKeyToBytes(dk));
}

/**
 * Encode a `deriveSubscriptionToken` output as the bare 32-byte hex that
 * `POST /v1/subscriptions` and `GET /v1/matches` expect. LE-32, matching
 * `detectionKeyToHex`.
 *
 * Not reduced mod `BABYJUB_SUBGROUP_ORDER`, unlike the detection scalars: the
 * token is not a curve scalar but an opaque identifier the server hashes and
 * compares, and reducing it would discard entropy.
 */
export function subscriptionTokenToHex(token: Field): string {
    return bytesToBareHex(toLeBytes(token, FIELD_BYTES));
}

export function fmdGenDetectionKey(
    randomScalar: () => Field,
    gamma = FMD_DEFAULT_GAMMA,
): FmdDetectionKey {
    const x = Array.from({ length: gamma }, () => {
        const xi = randomScalar() % BABYJUB_SUBGROUP_ORDER;
        return xi === 0n ? 1n : xi;
    });
    return { x };
}

export function fmdFlagKeyFromDetection(J: Jubjub, dk: FmdDetectionKey): FmdFlagKey {
    return { X: dk.x.map((xi) => J.mulPointEscalar(J.base8, xi)) };
}

/** Public clue key `ck = B · dk_root` — the value published in an address. */
export function fmdClueKeyFromRoot(J: Jubjub, dkRoot: Field): Point {
    return J.mulPointEscalar(J.base8, dkRoot % BABYJUB_SUBGROUP_ORDER);
}

// h_i = Poseidon(TAG_FMD_EXPAND, ck.x, ck.y, i) mod q. `ck` is bound into the
// hash so that no two receivers share an expansion.
//
// Reducing a Poseidon output (uniform in [0, r), r ~ 2^254.86) mod q ~ 2^251.03
// is non-uniform by a factor 8/7 at the low end. h_i is an additive blinder on
// a secret rather than a secret itself, so rejection sampling is unnecessary.
function expandScalar(P: Poseidon, ck: Point, i: number): Field {
    return P.hash([TAG_FMD_EXPAND, ck[0], ck[1], BigInt(i)]) % BABYJUB_SUBGROUP_ORDER;
}

/**
 * Expand a published clue key into the γ flag-key points, `X_i = ck + B·h_i`.
 * Sender side; requires no secret input.
 */
export function fmdExpandFlagKey(
    J: Jubjub,
    P: Poseidon,
    ck: Point,
    gamma = FMD_DEFAULT_GAMMA,
): FmdFlagKey {
    return {
        X: Array.from({ length: gamma }, (_, i) =>
            J.addPoint(ck, J.mulPointEscalar(J.base8, expandScalar(P, ck, i))),
        ),
    };
}

/**
 * Expand the root secret into the γ detection scalars,
 * `x_i = dk_root + h_i (mod q)` — the discrete logs of `fmdExpandFlagKey`'s
 * output. Receiver side.
 *
 * Must not apply `fmdGenDetectionKey`'s zero-scalar fixup: remapping a zero
 * `x_i` here and not in the flag key would desynchronise the two halves. A zero
 * `x_i` (probability ~2^-251) yields a constant clue bit on both sides, which
 * keeps them consistent.
 */
export function fmdExpandDetectionKey(
    J: Jubjub,
    P: Poseidon,
    dkRoot: Field,
    gamma = FMD_DEFAULT_GAMMA,
): FmdDetectionKey {
    const root = dkRoot % BABYJUB_SUBGROUP_ORDER;
    const ck = fmdClueKeyFromRoot(J, root);
    return {
        x: Array.from(
            { length: gamma },
            (_, i) => (root + expandScalar(P, ck, i)) % BABYJUB_SUBGROUP_ORDER,
        ),
    };
}

export function fmdFlag(J: Jubjub, P: Poseidon, fk: FmdFlagKey, r: Field): FmdClue {
    const gamma = fk.X.length;
    const rMod = r % BABYJUB_SUBGROUP_ORDER;
    if (rMod === 0n) throw new Error("fmd flag: r must be non-zero mod q");

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

    const cBits = unpackBits(clue.bits, clue.gamma);
    for (let i = 0; i < clue.gamma; i++) {
        const x = dk.x[i];
        if (x === undefined) return false;
        const shared = J.mulPointEscalar(R, x);
        if ((sharedBit(P, R, i, shared) ^ (cBits[i] ?? 0)) !== 1) return false;
    }
    return true;
}

/** @internal */
export function encodeClue(c: FmdClue): Uint8Array {
    const out = new Uint8Array(1 + 32 + c.bits.length);
    out[0] = c.gamma;
    out.set(c.R, 1);
    out.set(c.bits, 33);
    return out;
}

/** @internal */
export function decodeClue(buf: Uint8Array): FmdClue {
    const gamma = buf[0];
    if (gamma === undefined) {
        throw new WireFormatError("$.clue", "clue is empty; expected at least a gamma byte");
    }
    const want = 1 + 32 + Math.ceil(gamma / 8);
    if (buf.length < want) {
        throw new WireFormatError(
            "$.clue",
            `clue is ${buf.length} bytes; gamma ${gamma} needs ${want}`,
        );
    }
    return {
        gamma,
        R: buf.slice(1, 33),
        bits: buf.slice(33, 33 + Math.ceil(gamma / 8)),
    };
}

// Legendre-symbol bit of Poseidon([TAG_FMD_BIT, R.x, R.y, i, S.x, S.y]).
// Same six-input layout as the in-circuit `ClueCheck` (bit=1 ⟺ QR).
function sharedBit(P: Poseidon, R: Point, i: number, shared: Point): number {
    const h = P.hash([TAG_FMD_BIT, R[0], R[1], BigInt(i), shared[0], shared[1]]);
    const sym = legendreSymbol(h, BN254_FR);
    if (sym === 0) throw new Error("FMD shared bit: hash collided to zero");
    return sym === 1 ? 1 : 0;
}
