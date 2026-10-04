// Field elements and curve/field constants. Consensus-critical: they must
// match `circuits/src/lib/tags.circom` and the Rust indexer.

import { InvalidArgumentError } from "../errors/config.js";
import { fromBeBytes } from "./bytes.js";

/** A field element. Always a `bigint`; range depends on the field in use. */
export type Field = bigint;

/**
 * BN254 scalar field modulus: the Poseidon hash output range, and the modulus
 * every circuit signal is reduced by.
 */
export const BN254_FR =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Baby-Jubjub subgroup order. Scalars are reduced mod this. */
export const BABYJUB_SUBGROUP_ORDER =
    2736030358979909402780800718157159386076813972158567259200215660948447373041n;

/**
 * `8^-1` modulo {@link BABYJUB_SUBGROUP_ORDER}. For `R` in the prime-order
 * subgroup, `Q = [BABYJUB_INV8]R` satisfies `[8]Q = R`.
 */
export const BABYJUB_INV8 =
    2394026564107420727433200628387514462817212225638746351800188703329891451411n;

/** Order of the secp256k1 group: a valid EVM private key or ECDSA `s` is in `[1, n-1]`. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** `2^64` — the `asset_id` bound enforced by `HashToAssetGen`. */
export const POW_2_64 = 1n << 64n;

/**
 * Quadratic non-residue in the BN254 scalar field, `5^((r-1)/2) ≡ -1 (mod r)`, used by the
 * Legendre-symbol bit extraction in `crypto/sqrt.ts`.
 */
export const FMD_LEGENDRE_QNR = 5n;

// Range guards, named for the range they enforce. Each throws
// `InvalidArgumentError` on a value outside it.

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

/**
 * Spare bits a wide draw must carry above its modulus before reduction.
 * Reducing an `m`-bit uniform draw mod an `n`-bit modulus skews residues by at
 * most `2^-(m-n)`; 64 is the margin RFC 9380 §5 uses.
 */
export const REDUCE_SPARE_BITS = 64;

/**
 * Reduce wide big-endian bytes into `[1, modulus)`.
 *
 * Deterministic counterpart to `randomFr` / `randomJubjubScalar`: a key
 * derivation must be a pure function of its input, so uniformity comes from
 * extra input width rather than rejection sampling.
 *
 * Throws on a draw with fewer than {@link REDUCE_SPARE_BITS} spare bits: a
 * bare 256-bit hash folded into BN254 Fr has 2, which skews the low residues
 * by roughly 6:5.
 *
 * Zero maps to 1, since a zero `nsk` is degenerate (see
 * {@link assertNonZeroField}).
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
