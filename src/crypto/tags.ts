// Domain-separation tags. Must match circuits/src/lib/tags.circom byte-for-byte.
//
// No tag may be redeclared elsewhere, so a consensus constant cannot drift between modules.
//
// | Tag         | Value | Use
// | TAG_CM      | 1     | cm  = Poseidon(TAG_CM, packed_av, inner) arity 3
// | TAG_NF      | 2     | nf  = Poseidon(TAG_NF, nk, rho, cm)     arity 4
// | TAG_PK      | 3     | pk  = Poseidon(TAG_PK, ivk, d)          arity 3
// | TAG_IVK     | 4     | ivk = Poseidon(TAG_IVK, nsk)            arity 2
// | TAG_MERKLE  | 5     | node = Poseidon(TAG_MERKLE, c0..c3)     arity 5
// | TAG_DK      | 6     | dk  = Poseidon(TAG_DK, ivk)             off-circuit, FMD
// | (unused)    | 7     | reserved; do not use
// | TAG_FMD_BIT | 8     | FMD clue bit = Legendre(Poseidon(TAG_FMD_BIT, ...)) arity 6
// | TAG_NK      | 9     | nk  = Poseidon(TAG_NK, nsk)             arity 2
// | (unused)    | 10    | reserved; do not use
// | TAG_RHO     | 11    | out rho = Poseidon(TAG_RHO, nullifier[0], out_index) arity 3
// | TAG_SUB_TOKEN | 12  | sub token = Poseidon(TAG_SUB_TOKEN, ivk, epoch) arity 3, off-circuit
// | (unused)    | 13    | reserved; do not use
// | TAG_INNER   | 14    | inner = Poseidon(TAG_INNER, pk, rho, rcm) arity 4
// | TAG_DIGEST  | 15    | first block of the coefficient digest   arity 5
// | TAG_GD      | 16    | g_d candidate y = Poseidon(TAG_GD, d, ctr) arity 3, off-circuit
// | TAG_FMD_EXPAND2 | 17 | h_i = Poseidon(TAG_FMD_EXPAND2, i)     arity 2, off-circuit, FMD

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
export const TAG_FMD_BIT = 8n;
/** @internal */
export const TAG_NK = 9n;
/** @internal */
export const TAG_RHO = 11n;
/** @internal */
export const TAG_SUB_TOKEN = 12n;
/** @internal */
export const TAG_INNER = 14n;
/** @internal */
export const TAG_DIGEST = 15n;
export const TAG_GD = 16n;
export const TAG_FMD_EXPAND2 = 17n;
