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
    assetId,
    type Brand,
    type CircuitAmount,
    circuitAmount,
    type EvmAddress,
    evmAddress,
    type Hex32,
    hex32,
    type ShieldedAddress,
    shieldedAddress,
    type TokenAmount,
    tokenAmount,
} from "./brand.js";
export { FIELD_BYTES, fromLeBytes, toLeBytes } from "./bytes.js";
export { safeCall, safePhase } from "./callbacks.js";
export {
    arr,
    arrN,
    bigintFrom,
    bool,
    hexBytes,
    int,
    mapArr,
    obj,
    opt,
    str,
    tuple2,
} from "./decode.js";
export {
    BUILT_IN_LADDERS,
    type Decomposition,
    type DenominationPolicy,
    decompose,
    descendingAtMost,
    isDenomination,
    type Ladder,
    ladderFor,
    largestAtMost,
    nearest,
    resolveLadder,
} from "./denominations.js";
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
export { createHttpClient, type HttpClient, type HttpClientOptions } from "./http.js";
export {
    createJsonClient,
    type JsonClient,
    type JsonClientOptions,
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
    coeffCount,
    DEFAULT_SHAPE,
    shapeId,
    TRANSACT_4X6,
} from "./shape.js";
export type { Eip1193ProviderLike, EthSigner } from "./signer.js";
export { requestPersistentStorage } from "./storage.js";
export { formatUnits, parseUnits, RAY, toCircuitUnits, toTokenUnits } from "./units.js";
export { isHttpUrl, toAbsoluteUrl, type Url, urlToString } from "./url.js";
