// Domain-separation tags. Must match circuits/src/lib/tags.circom byte-for-byte.
//
// | Tag         | Value | Use
// | TAG_CM      | 1     | reserved
// | TAG_NF      | 2     | nf  = Poseidon(TAG_NF, nk, rho)         arity 3
// | TAG_PK      | 3     | pk  = Poseidon(TAG_PK, ivk)             arity 2
// | TAG_IVK     | 4     | ivk = Poseidon(TAG_IVK, nsk)            arity 2
// | TAG_MERKLE  | 5     | node = Poseidon(TAG_MERKLE, c0..c3)     arity 5
// | TAG_DK      | 6     | dk  = Poseidon(TAG_DK, ivk)             off-circuit, FMD
// | TAG_ASSET   | 7     | V^t = Pedersen(TAG_ASSET || asset_id_bits)  Pedersen(72)
// | TAG_NK      | 9     | nk  = Poseidon(TAG_NK, nsk)             arity 2
// | TAG_LEAF    | 10    | leaf = Poseidon(TAG_LEAF, cm, cv_dep_x, cv_dep_y) arity 4

/** @internal */
export const TAG_CM = 1n;
/** @internal */
export const TAG_NF = 2n;
/** @internal */
export const TAG_PK = 3n;
/** @internal */
export const TAG_IVK = 4n;
/** @internal */
export const TAG_MERKLE = 5n;
/** @internal */
export const TAG_DK = 6n;
/** @internal */
export const TAG_ASSET = 7n;
/** @internal */
export const TAG_NK = 9n;
/** @internal */
export const TAG_LEAF = 10n;

/** @internal */
export const POW_2_64 = 1n << 64n;

/** @internal */
// BN254 scalar field (Poseidon hash output range).
export const BN254_FR =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Baby-Jubjub subgroup order.
export const BABYJUB_SUBGROUP_ORDER =
    2736030358979909402780800718157159386076813972158567259200215660948447373041n;

/** @internal */
// Public QNR in BN254 scalar field for FMD Legendre-symbol bit-extraction gadget.
// 5^((r-1)/2) ≡ -1 (mod r). Mirrors `FMD_LEGENDRE_QNR` in circuits/src/lib/hash_to_bit.circom.
export const FMD_LEGENDRE_QNR = 5n;
