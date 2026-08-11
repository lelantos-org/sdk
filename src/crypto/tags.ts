// Domain-separation tags. Must match circuits/src/lib/tags.circom byte-for-byte.
//
// The whole table lives here — no tag may be redeclared elsewhere, so a
// consensus constant cannot drift between modules.
//
// | Tag         | Value | Use
// | TAG_CM      | 1     | reserved
// | TAG_NF      | 2     | nf  = Poseidon(TAG_NF, nk, rho, cm)     arity 4
// | TAG_PK      | 3     | pk  = Poseidon(TAG_PK, ivk)             arity 2
// | TAG_IVK     | 4     | ivk = Poseidon(TAG_IVK, nsk)            arity 2
// | TAG_MERKLE  | 5     | node = Poseidon(TAG_MERKLE, c0..c3)     arity 5
// | TAG_DK      | 6     | dk  = Poseidon(TAG_DK, ivk)             off-circuit, FMD
// | TAG_ASSET   | 7     | V^t = Pedersen(TAG_ASSET || asset_id_bits)  Pedersen(72)
// | TAG_FMD_BIT | 8     | FMD clue bit = Legendre(Poseidon(TAG_FMD_BIT, ...)) arity 6
// | TAG_NK      | 9     | nk  = Poseidon(TAG_NK, nsk)             arity 2
// | TAG_LEAF    | 10    | leaf = Poseidon(TAG_LEAF, cm, cv_dep_x, cv_dep_y) arity 4
// | TAG_RHO     | 11    | out rho = Poseidon(TAG_RHO, nullifier[0], out_index) arity 3
// | TAG_SUB_TOKEN | 12  | sub token = Poseidon(TAG_SUB_TOKEN, ivk, epoch) arity 3, off-circuit

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
export const TAG_FMD_BIT = 8n;
/** @internal */
export const TAG_NK = 9n;
/** @internal */
export const TAG_LEAF = 10n;
/** @internal */
export const TAG_RHO = 11n;
/** @internal */
export const TAG_SUB_TOKEN = 12n;
