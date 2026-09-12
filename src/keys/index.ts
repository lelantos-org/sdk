// Keys and addresses: the spending-key hierarchy, ZIP-32-lite HD
// derivation, bech32m addresses, and nsk resolution from any source.

export { ADDRESS_HRP, type DecodedAddress, decodeAddress, encodeAddress } from "./address.js";
export { detectionKey, parseAddress } from "./convenience.js";
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
    addressFromViewingKey,
    buildFullViewingKey,
    buildSpendingKey,
    buildViewingKey,
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
// Flat for the same reason: these work with any PRF-capable authenticator.
export {
    deriveNskFromPasskey,
    LELANTOS_PRF_SALT,
    type PrfEvaluator,
    prfOutputToNsk,
} from "./passkey.js";
export {
    decodeViewingKey,
    encodeFullViewingKey,
    encodeViewingKey,
    FVK_HRP,
    IVK_HRP,
    isFullViewingKey,
} from "./viewing-key.js";
