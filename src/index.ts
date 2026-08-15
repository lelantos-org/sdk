// Top-level barrel for `@lelantos-org/sdk`.
//
// What lives here is the surface an application needs: build a wallet, move
// value, read balances, handle errors. Anything narrower is reachable
// through a subpath export declared in `package.json`:
//
//   ./core ./crypto ./keys ./notes ./fmd ./protocol ./circuit ./bundle
//   ./chain ./permit2 ./prover ./relayer ./fmd-server ./quoter ./sync
//   ./wallet ./presets ./log ./networks ./errors
//
// Every name is forwarded explicitly, and only from a domain barrel — never a
// leaf module. `export *` is banned repo-wide, and `package.json#exports` has
// no wildcard, so a symbol is public if and only if a barrel forwards it.
//
// Sections follow the tier ladder (core → crypto → domain → protocol →
// adapters → builders → wallet), so ordering drift is mechanically visible.

// biome-ignore-all assist/source/organizeImports: grouped by tier, not path —
// the ordering documents the public surface.

export { VERSION } from "./version.js";

// ── errors: the most-caught surface. Also at ./errors ────────────────────
export {
    type AnyWalletError,
    DepositAdapterError,
    type DepositStrategy,
    EnvironmentError,
    type ErrorContext,
    InsufficientCoverError,
    InternalError,
    InvalidArgumentError,
    isWalletError,
    NetworkError,
    NetworkNotDeployedError,
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
    WireFormatError,
    WorkerRpcError,
    X402PaymentError,
    type X402RefusalReason,
} from "./core/errors.js";

// ── nominal types: addresses, hashes, asset ids, amount spaces ───────────
// Erased at runtime. Values the SDK returns are already branded; the
// constructors are for turning caller-supplied strings and bigints into them.
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
} from "./core/brand.js";

// ── circuit shape ────────────────────────────────────────────────────────
export {
    type CircuitShape,
    coeffCount,
    DEFAULT_SHAPE,
    TRANSACT_2X2,
    TRANSACT_3X3,
} from "./core/shape.js";

// ── amounts + HTTP options ───────────────────────────────────────────────
export { formatUnits, parseUnits, toCircuitUnits, toTokenUnits } from "./core/units.js";
export type { HttpClientOptions } from "./core/http.js";

// ── logging: off by default; install a sink to see anything ──────────────
export {
    configureLogging,
    consoleSink,
    type LogLevel,
    type LogRecord,
    type LogSink,
} from "./log/index.js";

// ── keys / addresses ─────────────────────────────────────────────────────
export {
    ADDRESS_HRP,
    type DecodedAddress,
    decodeAddress,
    deriveKeysFromMnemonic,
    deriveKeysFromNsk,
    deriveNskFromSigner,
    detectionKey,
    encodeAddress,
    generateMnemonic,
    isValidMnemonic,
    type KeySource,
    parseAddress,
    resolveNsk,
    type SpendingKey,
} from "./keys/index.js";

// ── chain adapters ───────────────────────────────────────────────────────
export {
    type AssetEntry,
    type CancelDepositInputs,
    type ChainAdapter,
    type Eip1193ProviderLike,
    Eip1193Signer,
    type EscrowedDepositView,
    type EthSigner,
    type DepositEscrowedRecord,
    type DeployedNetworkName,
    NETWORKS,
    type NetworkName,
    type PlaceholderNetworkName,
    type NetworkPreset,
    type Permit2SignArgs,
    PrivateKeySigner,
    resolveNetwork,
    supportsAllowanceTransfer,
    supportsNativeEth,
    type TokenMeta,
    ViemChainAdapter,
    type ViemChainAdapterOpts,
} from "./chain/index.js";

// ── prover: the types `connect()` options mention. Backends live at
// ./prover and ./wasm-prover so this barrel pulls no worker glue.
export type { Prover, ProverArtifacts, ProverPaths } from "./prover/index.js";

// ── wallet: the entrypoint most callers need ─────────────────────────────
export {
    type AssetInfo,
    type AssetInfoWithMeta,
    type AwaitCommitmentsOpts,
    type CoinSelector,
    type ConnectChainOptions,
    type ConnectExtraOptions,
    type ConnectKeyOptions,
    connect,
    type ConnectOptions,
    type ConsolidateFirst,
    type DepositOptions,
    type DepositPhase,
    type DepositResult,
    type DirectSelection,
    DEFAULT_ASSET,
    fetchAssetInfo,
    FmdMatchesNoteSource,
    FmdNoteSource,
    formatAmount,
    hasTokenMeta,
    HttpRelayerSubmitter,
    InMemoryNoteStore,
    minAmount,
    type ListNotesOpts,
    type NotesFile,
    type NotesFilter,
    // A custom `NoteSource` cannot be written without naming these two.
    type NotePage,
    type NoteSource,
    type NoteStore,
    type NullifierPersistence,
    NullifierStore,
    type NullifierStoreState,
    type OnPhase,
    parseAmount,
    requireTokenMeta,
    type SelectionResult,
    type SelectOpts,
    SfrtCoinSelector,
    type SpendPhase,
    type ConsolidateHint,
    type StoredNote,
    type Submitter,
    type SwapOptions,
    type SwapResult,
    type SyncProgress,
    type SyncResult,
    type SyncStrategy,
    syncWallet,
    type TransactionResult,
    type TransferOptions,
    type TransferResult,
    type TreePersistence,
    TreeStore,
    type TreeStoreState,
    Wallet,
    type WalletApi,
    type WalletConfig,
    type WalletNote,
    type WalletNotePayload,
    type WithdrawEthOptions,
    type WithdrawOptions,
    type WithdrawResult,
} from "./wallet/index.js";

// ── presets ──────────────────────────────────────────────────────────────
export {
    fastWallet,
    type FastWalletOpts,
    nodeWallet,
    type NodeWalletOpts,
} from "./presets/index.js";

// ── wasm configuration ───────────────────────────────────────────────────
export { configureWasm, type WasmConfig } from "./configure-wasm.js";
