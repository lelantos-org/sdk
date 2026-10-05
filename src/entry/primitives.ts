// `@lelantos-org/sdk/primitives`: hex/bytes/field/randomness, Poseidon and Jubjub, keys,
// diversifiers and addresses, the note codec, output-secret derivation and FMD.

export { bitAt, packBits, unpackBits } from "../core/bits.js";
export type { Brand } from "../core/brand.js";
export { FIELD_BYTES, fromLeBytes, toLeBytes } from "../core/bytes.js";
export {
    BABYJUB_SUBGROUP_ORDER,
    BN254_FR,
    type Field,
    FMD_LEGENDRE_QNR,
    POW_2_64,
} from "../core/field.js";
export {
    bigintToHex,
    bytesToBareHex,
    bytesToHex,
    fieldToBytes32,
    hexToBigint,
    hexToBytes,
} from "../core/hex.js";
export {
    noteId,
    randomBelow,
    randomBytes,
    randomFr,
    randomJubjubScalar,
    randomU256,
    requireWebCrypto,
    shuffled,
} from "../core/random.js";
export { isHttpUrl, toAbsoluteUrl, type Url, urlToString } from "../core/url.js";
export {
    buildInner,
    buildNoteCommitment,
    commitWithInner,
    type NoteCommitInput,
} from "../crypto/commit.js";
export { type CryptoContext, cryptoContext, cryptoContextIfReady } from "../crypto/context.js";
export {
    deriveDk,
    deriveIvk,
    deriveNk,
    derivePk,
    derivePkFromIvk,
    deriveSubscriptionToken,
} from "../crypto/derive.js";
export { DIVERSIFIER_BYTES, diversifiedBase } from "../crypto/diversified-base.js";
export type { Point } from "../crypto/jubjub.js";
export { Jubjub } from "../crypto/jubjub-wasm/index.js";
export { configureJubjubWasm, type JubjubWasmLoader } from "../crypto/jubjub-wasm/loader.js";
export { type MerkleProof, MerkleTree } from "../crypto/merkle.js";
export { buildNullifier, buildNullifierFromNsk } from "../crypto/nullifier.js";
export { type IsKnownRoot, type PathCheck, rootFromPath, verifyPath } from "../crypto/path.js";
export { Poseidon, type PoseidonBackend } from "../crypto/poseidon.js";
export { configurePoseidonWasm, type PoseidonWasmLoader } from "../crypto/poseidon-wasm/loader.js";
export { buildRho } from "../crypto/rho.js";
export { fmdLegendreWitness, legendreSymbol, modInverse, modSqrt } from "../crypto/sqrt.js";
export {
    TAG_CM,
    TAG_DIGEST,
    TAG_DK,
    TAG_FMD_BIT,
    TAG_FMD_EXPAND2,
    TAG_GD,
    TAG_INNER,
    TAG_IVK,
    TAG_MERKLE,
    TAG_NF,
    TAG_NK,
    TAG_PK,
    TAG_RHO,
    TAG_SUB_TOKEN,
} from "../crypto/tags.js";
export { FMD_DOMAIN, type FmdClue, fmdFlagOnBase, fmdTest } from "../fmd/clue.js";
export {
    decodeClue,
    detectionKeyToBytes,
    detectionKeyToHex,
    encodeClue,
    subscriptionTokenToHex,
} from "../fmd/codec.js";
export {
    fmdDiversifiedDetectionKey,
    fmdDiversifiedFlagKey,
    fmdExpectedClue,
} from "../fmd/diversified.js";
export {
    assertDetectionGamma,
    FMD_DEFAULT_GAMMA,
    type FmdDetectionKey,
    type FmdFlagKey,
    fmdFlagKeyFromDetection,
    fmdGenDetectionKey,
} from "../fmd/keys.js";
export { ADDRESS_HRP, type DecodedAddress, decodeAddress, encodeAddress } from "../keys/address.js";
export { deriveClaimLinkNsk } from "../keys/claim-link.js";
export { detectionKey } from "../keys/convenience.js";
export {
    buildDiversifiedKeys,
    type DiversifiedKeys,
    deriveDiversifiedPk,
    deriveDkRoot,
    ownsAddress,
} from "../keys/diversified.js";
export {
    DEFAULT_DIVERSIFIER_INDEX,
    DIVERSIFIER_INDEX_BOUND,
    defaultDiversifier,
    deriveDiversifierKey,
    diversifierAt,
    diversifierIndex,
    diversifierToBytes,
    diversifierToField,
} from "../keys/diversifier.js";
export {
    accountPath,
    deriveAccount,
    deriveChildHardened,
    type ExtendedSpendingKey,
    LELANTOS_COIN_TYPE,
    masterFromSeed,
    mnemonicToAccountKey,
    ZIP32_PURPOSE,
} from "../keys/hd.js";
export { hexPrivateKeyToNsk } from "../keys/key-source.js";
export {
    addressFromViewingKey,
    buildFullViewingKey,
    buildSpendingKey,
    buildViewingKey,
    type DerivedWalletKeys,
    type DeriveFromMnemonicOpts,
    deriveKeysFromNsk,
    detectionKeyFor,
    type FullViewingKey,
    fullViewingKeyFromSpending,
    type SpendingKey,
    type ViewingKey,
    viewingKeyFromSpending,
} from "../keys/keys.js";
export {
    LELANTOS_NSK_DOMAIN,
    lelantosTypedDataHash,
    reduceSignatureToScalar,
} from "../keys/metamask.js";
export { deriveKeysFromMnemonic } from "../keys/mnemonic.js";
export { LELANTOS_PRF_SALT, prfOutputToNsk } from "../keys/passkey.js";
export { FVK_HRP, IVK_HRP } from "../keys/viewing-key.js";
export {
    type BuildAuxArgs,
    buildOutputAux,
    ON_CURVE_IDENTITY,
    type OutputAux,
    type OutputAuxWithWitness,
} from "../notes/aux.js";
export {
    CLUE_BITS_PREFIX_BYTES,
    clueBitsToPrefix,
    stripClueBitsPrefix,
    withClueBitsPrefix,
} from "../notes/codec.js";
export { decryptNote, type EncryptArgs, encryptNote } from "../notes/encrypt.js";
export type { EncryptedNote, Note, SpentNote } from "../notes/note.js";
export { deriveOutgoingKey } from "../notes/outgoing.js";
export {
    deriveDepositRho,
    deriveOutputSecret,
    type ExpandedSeed,
    expandSeed,
    type OutputSecretInputs,
    seedFromSecret,
} from "../notes/seed.js";
