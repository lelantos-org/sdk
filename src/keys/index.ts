// Keys and addresses: the spending-key hierarchy, ZIP-32-lite HD
// derivation, bech32m addresses, and nsk resolution from any source.

export { ADDRESS_HRP, type DecodedAddress, decodeAddress, encodeAddress } from "./address.js";
export {
    accountPath,
    deriveAccount,
    deriveChildHardened,
    type ExtendedSpendingKey,
    LELANTOS_COIN_TYPE,
    masterFromSeed,
    mnemonicToAccountKey,
    ZIP32_PURPOSE,
} from "./hd.js";
export {
    generateMnemonic,
    hexPrivateKeyToNsk,
    isValidMnemonic,
    type KeySource,
    resolveNsk,
} from "./key-source.js";
export {
    addressFromSpendingKey,
    buildSpendingKey,
    deriveKeysFromMnemonic,
    deriveKeysFromNsk,
    detectionKeyFor,
    type FullViewingKey,
    fullViewingKeyFromSpending,
    type SpendingKey,
    type ViewingKey,
    viewingKeyFromSpending,
} from "./keys.js";
// Flat, not `export * as metamask`: these work with any EIP-712 signer.
export {
    deriveNskFromSigner,
    LELANTOS_NSK_DOMAIN,
    lelantosTypedDataHash,
    reduceSignatureToScalar,
} from "./metamask.js";
