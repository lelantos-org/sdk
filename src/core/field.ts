// Field elements and curve/field constants.
//
// These values are consensus-critical: they must match
// `circuits/src/lib/tags.circom` and the Rust indexer byte-for-byte.
// Single-sourced here to prevent drift.

import { InvalidArgumentError } from "../errors/config.js";
import { fromBeBytes } from "./bytes.js";

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

/** Order of the secp256k1 group: a valid EVM private key or ECDSA `s` is in `[1, n-1]`. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

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
// Shared checks that a bigint is in the range its consumer requires, so every
// violation throws `InvalidArgumentError` with a consistent message. Named for
// the range they enforce, so a call site states what it needs rather than how
// to check it.

/**
 * A canonical BN254 field element: `[0, r)`.
 *
 * `poseidon-lite` reduces mod `r` internally, so `x` and `x + r` hash
 * identically and two distinct decoded records could be made to collide.
 */
export function assertField(value: Field, what: string): void {
    assertRange(value, 0n, BN254_FR, what, "a canonical field element in [0, BN254_FR)");
}

/**
 * A canonical non-zero field element: `(0, r)`.
 *
 * For values whose zero case degenerates: `nsk = 0` gives `pk_d = O`, an
 * identity ECDH key whose incoming notes are publicly decryptable.
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
 * 64 is the standard margin (as in RFC 9380 §5): reducing an `m`-bit uniform
 * draw mod an `n`-bit modulus skews residues by at most `2^-(m-n)`, which at 64
 * spare bits is negligible.
 */
export const REDUCE_SPARE_BITS = 64;

/**
 * Reduce wide big-endian bytes into `[1, modulus)`.
 *
 * Deterministic counterpart to `randomFr` / `randomJubjubScalar`, which use
 * rejection sampling. A key derivation must be a pure function of its input,
 * so it obtains uniformity from extra input width instead of redrawing.
 *
 * Folding a bare 256-bit hash into BN254 Fr leaves 2 spare bits and skews the
 * low residues by roughly 6:5, so a draw with fewer than
 * {@link REDUCE_SPARE_BITS} spare bits is a programming error and throws.
 *
 * Zero maps to 1: it is unreachable in practice (probability ~`2^-254`) and
 * `nsk = 0` degenerates to `pk_d = O`, an identity ECDH key whose incoming
 * notes are publicly decryptable.
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
    const r = fromBeBytes(bytes) % modulus;
    return r === 0n ? 1n : r;
}
