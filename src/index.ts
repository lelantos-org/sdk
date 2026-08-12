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

// ── crypto primitives ────────────────────────────────────────────────────
export {
    BABYJUB_SUBGROUP_ORDER,
    buildNoteCommitment,
    buildNullifier,
    buildNullifierFromNsk,
    deriveSubscriptionToken,
    type Field,
    fromLeBytes,
    Jubjub,
    type MerkleProof,
    MerkleTree,
    type Point,
    Poseidon,
    toLeBytes,
} from "./crypto/index.js";
export { configureJubjubWasm } from "./crypto/jubjub-wasm/index.js";
export { type PathCheck, rootFromPath, verifyPath } from "./crypto/path.js";

// ── keys / addresses ─────────────────────────────────────────────────────
export {
    ADDRESS_HRP,
    addressFromSpendingKey,
    buildSpendingKey,
    type DecodedAddress,
    decodeAddress,
    deriveKeysFromMnemonic,
    deriveKeysFromNsk,
    deriveNskFromSigner,
    encodeAddress,
    type FullViewingKey,
    fullViewingKeyFromSpending,
    generateMnemonic,
    isValidMnemonic,
    type KeySource,
    resolveNsk,
    type SpendingKey,
    type ViewingKey,
    viewingKeyFromSpending,
} from "./keys/index.js";

// ── FMD ──────────────────────────────────────────────────────────────────
export {
    detectionKeyToHex,
    FMD_DEFAULT_GAMMA,
    type FmdDetectionKey,
    type FmdFlagKey,
    fmdFlag,
    fmdFlagKeyFromDetection,
    fmdGenDetectionKey,
    fmdTest,
    subscriptionTokenToHex,
} from "./fmd/index.js";

// ── notes ────────────────────────────────────────────────────────────────
export { decryptNote, encryptNote } from "./notes/index.js";
export type { EncryptedNote, Note, SpentNote } from "./notes/index.js";

// ── protocol wire contract ───────────────────────────────────────────────
export {
    type AuxOutput,
    computePiHash,
    type DepositIntent,
    type SpendKind,
    type SubmitSwapPayload,
    type SubmitTransactPayload,
} from "./protocol/index.js";

// ── permit2 ──────────────────────────────────────────────────────────────
export { signPermit2Witness } from "./permit2/index.js";

// ── chain adapters ───────────────────────────────────────────────────────
export {
    type AssetEntry,
    type CancelIntentInputs,
    type ChainAdapter,
    type Eip1193ProviderLike,
    Eip1193Signer,
    type EscrowedIntentView,
    type EthSigner,
    type IntentEscrowedRecord,
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

// ── prover backends ──────────────────────────────────────────────────────
// `WasmProver` lives at `@lelantos-org/sdk/wasm-prover` so the main barrel
// does not pull in `wasm-bindgen-rayon` worker glue. Browser apps that opt
// out via `useWasmProver: false` pay zero bundle cost.
export {
    browserWorkerProver,
    prove,
    type Prover,
    type ProverArtifacts,
    type ProverPaths,
    SnarkjsProver,
    verify,
    WorkerProver,
} from "./prover/index.js";

// ── services ─────────────────────────────────────────────────────────────
export { RelayerClient } from "./services/relayer/index.js";
export {
    type CommitmentChunkEntry,
    type CommitmentChunkOut,
    type CreateSubscriptionInput,
    FmdClient,
    type FmdMatchOut,
    type FmdNoteOut,
    type FmdTreeState,
    GAMMA_MAX,
    GAMMA_MIN,
    type NullifierChunkOut,
    type SubscriptionOut,
} from "./services/fmd-server/index.js";
export {
    fetchSwapQuote,
    quoteAgeSecs,
    type SwapQuote,
    type SwapQuoteRequest,
} from "./services/quoter/index.js";

// ── scanning ─────────────────────────────────────────────────────────────
export {
    LocalScanner,
    type ScanHit,
    type ScanInput,
    type Scanner,
    scanNotes,
    type ScanStats,
    WorkerPoolScanner,
} from "./sync/index.js";

// ── bundle builders (custom spend flows) ─────────────────────────────────
export {
    buildDeposit,
    buildSpend,
    type InputSlot,
    type OutputRecipient,
    type SpendArgs,
} from "./bundle/index.js";

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
    type NotesFile,
    type NotesFilter,
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
