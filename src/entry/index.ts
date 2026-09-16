// `@lelantos-org/sdk`: the application surface.
//
// Connect a wallet, move value, read balances and state, convert amounts, handle errors. Everything
// else has exactly one other home: `./watch`, `./x402`, `./advanced`, `./prover`, `./protocol`,
// `./primitives`, `./services`, `./internal` (see the README subpath table).
//
// Rule 8 (`scripts/check-layers.mjs`): an entry only forwards names, explicitly, from the modules that
// declare them. `scripts/check-public-api.mjs` fails when a name is published from two subpaths.

export {
    type DeployedNetworkName,
    NETWORKS,
    type NetworkName,
    type NetworkPreset,
    type PlaceholderNetworkName,
    type PlaceholderNetworkPreset,
} from "../chain/networks.js";
export type { OperationLocation } from "../chain/operation.js";
export { configureWasm, type WasmConfig } from "../configure-wasm.js";
export {
    type AssetId,
    type AssetIdLike,
    assetId,
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
} from "../core/brand.js";
export {
    type ErrorContext,
    type ErrorDetails,
    InternalError,
    WalletError,
} from "../errors/base.js";
export {
    ChainRpcError,
    type DepositStrategy,
    NoEvmAccountError,
    TxMiningError,
    TxRevertedError,
    UnsupportedOperationError,
    type UserRejectedAction,
    UserRejectedError,
} from "../errors/chain.js";
export { WALLET_ERROR_CODES, type WalletErrorCode } from "../errors/codes.js";
export {
    EnvironmentError,
    InvalidArgumentError,
    NetworkNotDeployedError,
    WalletConfigError,
} from "../errors/config.js";
export {
    type ConsolidateHint,
    FeeAssetNotQuotedError,
    type FeeQuoteKind,
    type HeldBucket,
    type HeldNotes,
    InsufficientBalanceError,
    InsufficientCoverError,
    type InsufficientCoverReason,
    NotesHeldError,
} from "../errors/funds.js";
export { type AnyWalletError, isWalletError, type WalletErrorOf } from "../errors/guard.js";
export {
    type NetworkAttempt,
    NetworkError,
    type NetworkErrorCode,
    type NetworkFailureCode,
    type NetworkTimeoutCode,
    TreeOutOfSyncError,
    WireFormatError,
} from "../errors/network.js";
export {
    ProverArtifactsFailedError,
    ProverArtifactsMissingError,
    ProverError,
    ProverUnavailableError,
} from "../errors/prover.js";
export {
    DeadlinePassedError,
    QuoteStaleError,
    RelayerRejectedError,
    type RelayerRejectReason,
    SpendOutcomeUnknownError,
} from "../errors/spend.js";
export { type WorkerErrorCode, WorkerRpcError } from "../errors/worker.js";
export { X402PaymentError, type X402RefusalReason } from "../errors/x402.js";
export { parseAddress } from "../keys/convenience.js";
export { generateMnemonic, isValidMnemonic } from "../keys/key-source.js";
export { deriveNskFromSigner } from "../keys/metamask.js";
export { deriveNskFromPasskey, type PrfEvaluator } from "../keys/passkey.js";
export type { Eip1193ProviderLike, EthSigner } from "../keys/signer.js";
export {
    decodeViewingKey,
    encodeFullViewingKey,
    encodeViewingKey,
    isFullViewingKey,
} from "../keys/viewing-key.js";
export { type ConsoleSinkOptions, consoleSink } from "../log/console-sink.js";
export {
    configureLogging,
    type LoggingConfig,
    type LogLevel,
    type LogRecord,
    type LogSink,
} from "../log/logger.js";
export type { CircuitShape } from "../protocol/shape.js";
export type { WorkerFactory, WorkerLike } from "../runtime/rpc/types.js";
export { VERSION } from "../version.js";
export type {
    ReadOnlyWalletApi,
    SpendableMaxOptions,
    SpendingWalletKeys,
    WalletApi,
    WalletCapabilities,
    WalletKeys,
} from "../wallet/api.js";
export {
    type Amount,
    type AssetUnits,
    formatAmount,
    fromBaseUnits,
    type OutAmount,
    parseAmount,
    type Rounding,
    toBaseUnits,
} from "../wallet/assets/amount.js";
export { isOnLadder, minAmount, nearestDenomination } from "../wallet/assets/amounts.js";
export type { AssetRef } from "../wallet/assets/asset-ref.js";
export type { AssetInfo } from "../wallet/assets/info.js";
export { connect } from "../wallet/connect/index.js";
export type {
    ChainOptions,
    ConnectExtras,
    ConnectOptions,
    ConnectStorage,
    HttpOptions,
    KeyOptions,
    NetworkOptions,
    ProverConfig,
    ProverOption,
    RetryInfo,
    ScannerOption,
} from "../wallet/connect/options.js";
export type { AwaitCommitmentsResult } from "../wallet/notes/note-cache.js";
export type { DenominationChoice, WithdrawPreview } from "../wallet/ops/withdraw-preview.js";
export type { SpendableMax, WithheldValue } from "../wallet/selection/types.js";
export type {
    AllowanceSetupOptions,
    AllowanceSetupProgress,
    AllowanceSetupStep,
    CancelDepositTarget,
    DepositOptions,
    DepositPhase,
    NotesFilter,
    OpOptions,
    Phase,
    PhaseInfo,
    QuoteSwapOptions,
    SelectionOptions,
    SpendOptions,
    SpendPhase,
    SwapOptions,
    TransferOptions,
    WithdrawOptions,
} from "../wallet/types/options.js";
export type {
    DepositPull,
    DepositQuote,
    FeeKind,
    FeeOption,
    FeeQuote,
    SwapFees,
    SwapQuote,
    TokenAllowanceState,
} from "../wallet/types/quotes.js";
export type {
    CancelDepositResult,
    DepositEscrow,
    DepositResult,
    FeeBreakdown,
    Money,
    SwapResult,
    TransactionResult,
    TransferResult,
    WalletNote,
    WalletNotePayload,
    WithdrawResult,
} from "../wallet/types/results.js";
export type {
    AwaitCommitmentsOptions,
    Balance,
    NotesSyncSummary,
    OpActivity,
    StateListener,
    SyncOptions,
    SyncProgress,
    SyncReport,
    WalletState,
} from "../wallet/types/sync.js";
