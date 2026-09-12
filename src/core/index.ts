// Tier 0. Nothing here imports anything else under `src/`.
//
// Field constants, byte and hex codecs, randomness, fee arithmetic, the error
// taxonomy, and HTTP. Anything shared by two domains belongs here rather than
// in either of them.

export { type RetryPolicy, retry, type SleepOutcome, sleep, withTimeout } from "./async.js";
export { bitAt, packBits, unpackBits } from "./bits.js";
// `branded` is not re-exported: it is the `@internal` unvalidated
// escape hatch, and publishing it would let consumers bypass every constructor
// below. SDK code imports it from `./brand.js` directly.
export {
    type AssetId,
    type AssetIdLike,
    assetId,
    type Brand,
    type CircuitAmount,
    type CircuitAmountLike,
    circuitAmount,
    type EvmAddress,
    type EvmAddressLike,
    evmAddress,
    type Hex32,
    hex32,
    type ShieldedAddress,
    type ShieldedAddressLike,
    shieldedAddress,
    type TokenAmount,
    tokenAmount,
    type ViewingKeyString,
} from "./brand.js";
export { FIELD_BYTES, fromLeBytes, toLeBytes } from "./bytes.js";
export { safeCall, safePhase } from "./callbacks.js";
// The `decode.js` combinators (`arr`/`obj`/`str`/`int`/…) are deliberately not
// published: they are INBOUND-ONLY wire validators with names generic enough
// to collide in a consumer's module scope, and nothing outside the SDK builds
// on them.
export { bigintFrom, hexBytes } from "./decode.js";
export {
    type Decomposition,
    type DenominationPolicy,
    decompose,
    descendingAtMost,
    isDenomination,
    type Ladder,
    type LadderInputs,
    largestAtMost,
    nearest,
    resolveLadder,
    universalLadder,
} from "./denominations.js";
// EIP-712 shapes. `EthSigner.signTypedData` takes them, so a caller writing
// their own signer has to be able to name them.
export type { TypedDataDomain, TypedDataParameter } from "./eip712.js";
export {
    type AnyWalletError,
    attachContext,
    DepositAdapterError,
    type DepositStrategy,
    EnvironmentError,
    type ErrorContext,
    InsufficientCoverError,
    InternalError,
    InvalidArgumentError,
    isWalletError,
    NetworkError,
    type NetworkErrorCode,
    type NetworkFailureCode,
    NetworkNotDeployedError,
    type NetworkTimeoutCode,
    NoDepositAccountError,
    PermitRejectedError,
    ProverArtifactsFailedError,
    ProverArtifactsMissingError,
    ProverError,
    SelectionError,
    TxMiningError,
    WALLET_ERROR_CODES,
    WalletConfigError,
    WalletError,
    type WalletErrorCode,
    type WalletErrorOf,
    type WalletErrorOptions,
    WireFormatError,
    type WorkerErrorCode,
    WorkerRpcError,
} from "./errors.js";
export {
    applyFee,
    assertPublicInFits,
    BPS_DENOMINATOR,
    type FeeOverride,
    type FeeRates,
    PUBLIC_IN_MAX,
    resolveFeeRates,
    unitFee,
    type WithdrawNet,
    type WithdrawNetArgs,
    withdrawNet,
} from "./fees.js";
export {
    BABYJUB_SUBGROUP_ORDER,
    BN254_FR,
    type Field,
    FMD_LEGENDRE_QNR,
    POW_2_64,
} from "./field.js";
export {
    bigintToHex,
    bytesToBareHex,
    bytesToHex,
    fieldToBytes32,
    hexToBigint,
    hexToBytes,
} from "./hex.js";
export {
    createHttpClient,
    type HttpClient,
    type HttpClientOptions,
    PRIVACY_REQUEST_DEFAULTS,
} from "./http.js";
export {
    createJsonClient,
    type JsonClient,
    type JsonClientOptions,
    type JsonRequestOptions,
    type QueryParams,
} from "./json-client.js";
export { decodeStoredNote, type NoteRecord, type StoredNote } from "./note-record.js";
export {
    noteId,
    randomBelow,
    randomBytes,
    randomFr,
    randomJubjubScalar,
    randomU256,
    requireWebCrypto,
    shuffled,
} from "./random.js";
export {
    type CircuitShape,
    challengeWordCount,
    coeffCount,
    DEFAULT_SHAPE,
    shapeId,
    TRANSACT_4X6,
} from "./shape.js";
export type { Eip1193ProviderLike, EthSigner } from "./signer.js";
export { requestPersistentStorage } from "./storage.js";
export {
    formatUnits,
    parseUnits,
    RAY,
    toCircuitUnits,
    toTokenUnits,
    toTokenUnitsAtRate,
    type YieldRate,
} from "./units.js";
export { isHttpUrl, toAbsoluteUrl, type Url, urlToString } from "./url.js";
