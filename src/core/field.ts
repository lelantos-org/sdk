// Field elements and curve/field constants.
//
// These values are consensus-critical: they must match
// `circuits/src/lib/tags.circom` and the Rust indexer byte-for-byte.
// Single-sourced here so no second copy can drift.

import { InvalidArgumentError } from "./errors.js";

/** A field element. Always a `bigint`; range depends on the field in use. */
export type Field = bigint;

/**
 * BN254 scalar field modulus — the Poseidon hash output range, and the
 * modulus every circuit signal is reduced by.
 */
export const BN254_FR =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Baby-Jubjub subgroup order. Scalars are reduced mod this. */
export const BABYJUB_SUBGROUP_ORDER =
    2736030358979909402780800718157159386076813972158567259200215660948447373041n;

/** `2^64` — the `asset_id` bound enforced by `HashToAssetGen`. */
export const POW_2_64 = 1n << 64n;

/**
 * Public quadratic non-residue in the BN254 scalar field, used by the FMD
 * Legendre-symbol bit-extraction gadget: `5^((r-1)/2) ≡ -1 (mod r)`.
 * Mirrors `FMD_LEGENDRE_QNR` in `circuits/src/lib/hash_to_bit.circom`.
 */
export const FMD_LEGENDRE_QNR = 5n;

// --- range guards ------------------------------------------------------------
//
// One vocabulary for "is this bigint in the range its consumer requires".
//
// The same `x < 0n || x >= LIMIT` test was hand-written at eight call sites,
// with eight different message spellings and three different error types — so
// the *same* mistake read differently depending on where it surfaced, and a
// caller filtering on error type caught some and not others. These are named
// for the range they enforce, so a call site says what it needs rather than
// how to check it.

/**
 * A canonical BN254 field element: `[0, r)`.
 *
 * Non-canonical values are the hazard Poseidon cannot see: `poseidon-lite`
 * reduces mod `r` internally, so `x` and `x + r` hash identically and two
 * distinct decoded records can be made to collide by construction.
 */
export function assertField(value: Field, what: string): void {
    assertRange(value, 0n, BN254_FR, what, "a canonical field element in [0, BN254_FR)");
}

/**
 * A canonical non-zero field element: `(0, r)`.
 *
 * For values whose zero case degenerates — an `nsk` of 0 gives `pk_d = O`, an
 * identity ECDH key whose every incoming note is publicly decryptable.
 */
export function assertNonZeroField(value: Field, what: string): void {
    assertRange(value, 1n, BN254_FR, what, "in (0, BN254_FR)");
}

/** An unsigned 64-bit integer: `[0, 2^64)`. The circuit range-checks these. */
export function assertU64(value: Field, what: string): void {
    assertRange(value, 0n, POW_2_64, what, "a 64-bit unsigned integer");
}

/** `[min, maxExclusive)`, reported against `expectation`. */
export function assertRange(
    value: Field,
    min: Field,
    maxExclusive: Field,
    what: string,
    expectation: string,
): void {
    if (value < min || value >= maxExclusive) {
        throw new InvalidArgumentError(`${what} must be ${expectation}; got ${value}`, {
            argument: what,
        });
    }
}

// --- deterministic reduction -------------------------------------------------

/**
 * Spare bits a wide draw must carry above its modulus before reduction.
 *
 * 64 is the usual margin (RFC 9380 §5 uses the same): reducing an `m`-bit
 * uniform draw mod an `n`-bit modulus skews residues by at most `2^-(m-n)`, so
 * 64 spare bits puts the skew below any distinguisher that matters.
 */
export const REDUCE_SPARE_BITS = 64;

/**
 * Reduce wide big-endian bytes into `[1, modulus)`.
 *
 * The deterministic counterpart to `randomFr` / `randomJubjubScalar`, which
 * reject rather than reduce. Rejection is exact but needs to redraw; a key
 * derivation has to be a pure function of its input, so it buys uniformity
 * with extra input width instead.
 *
 * The width is not optional. Folding a bare 256-bit hash into BN254 Fr leaves
 * 2 spare bits and skews the low residues by roughly 6:5 — the reason this
 * function exists — so a draw with less than {@link REDUCE_SPARE_BITS} to
 * spare is a programming error and throws rather than silently biasing a key.
 *
 * Zero maps to 1: it is unreachable in practice (probability ~`2^-254`) and
 * `nsk = 0` degenerates to `pk_d = O`, an identity ECDH key whose every
 * incoming note is publicly decryptable.
 */
export function reduceWideToField(bytes: Uint8Array, modulus: Field, what: string): Field {
    const spare = bytes.length * 8 - modulus.toString(2).length;
    if (spare < REDUCE_SPARE_BITS) {
        throw new InvalidArgumentError(
            `${what}: reducing ${bytes.length * 8} bits mod a ` +
                `${modulus.toString(2).length}-bit modulus leaves ${spare} spare bits, ` +
                `below the ${REDUCE_SPARE_BITS} needed for a negligibly biased result`,
            { argument: what },
        );
    }
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    const r = v % modulus;
    return r === 0n ? 1n : r;
}
