// Domain-separation tags. Must match circuits/src/lib/tags.circom byte-for-byte.
//
// | Tag         | Value | Use
// | TAG_CM      | 1     | reserved
// | TAG_NF      | 2     | nf  = Poseidon(TAG_NF, nsk, rho)        arity 3
// | TAG_PK      | 3     | pk  = Poseidon(TAG_PK, ivk)             arity 2
// | TAG_IVK     | 4     | ivk = Poseidon(TAG_IVK, nsk)            arity 2
// | TAG_MERKLE  | 5     | node = Poseidon(TAG_MERKLE, c0..c3)     arity 5
// | TAG_DK      | 6     | dk  = Poseidon(TAG_DK, ivk)             off-circuit, FMD

export const TAG_CM = 1n;
export const TAG_NF = 2n;
export const TAG_PK = 3n;
export const TAG_IVK = 4n;
export const TAG_MERKLE = 5n;
export const TAG_DK = 6n;

export const POW_2_64 = 1n << 64n;

// BN254 scalar field (Poseidon hash output range).
export const BN254_FR =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// Baby-Jubjub subgroup order (used to reduce derived scalars).
export const BABYJUB_SUBGROUP_ORDER =
    2736030358979909402780800718157159386076813972158567259200215660948447373041n;
