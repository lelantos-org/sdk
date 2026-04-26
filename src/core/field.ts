// Field elements and curve/field constants.
//
// These values are consensus-critical: they must match
// `circuits/src/lib/tags.circom` and the Rust indexer byte-for-byte.
// Single-sourced here so no second copy can drift.

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
