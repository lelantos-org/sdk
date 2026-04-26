// Top-level barrel for `@lelantos-org/sdk`.
//
// Domain barrels (`./keys`, `./notes`, `./fmd`, `./bundle`, `./prover`,
// `./relayer`, `./sync`, `./chain`) are also published as subpath exports
// from `package.json` for callers who want narrower import surfaces.
//
// Every name is forwarded explicitly so `tsc`/biome can audit the public
// surface. Add new exports by name, not via `export *`.

// ── bundle (transact + deposit intent builders) ──────────────────────────
export type {
    InputSlot,
    OutputRecipient,
} from "./bundle/common.js";
export { buildDeposit } from "./bundle/deposit.js";
export {
    type AuxOutput,
    computePiHash,
    type DepositIntent,
    signPermit2Witness,
} from "./bundle/permit2.js";
export {
    fiatShamirZ,
    flatten,
    hornerEval,
} from "./bundle/snark-compression.js";
export {
    fetchSwapQuote,
    quoteAgeSecs,
    type SwapQuote,
    type SwapQuoteRequest,
} from "./bundle/swap-quote.js";
export { buildTransfer } from "./bundle/transfer.js";

export { buildWithdraw } from "./bundle/withdraw.js";
export {
    dummyInputAt,
    type SpendableCachedNote,
    toCircomInput,
} from "./bundle/witness.js";
// ── chain adapters ───────────────────────────────────────────────────────
export {
    type AssetEntry,
    type ChainAdapter,
    supportsAllowanceTransfer,
} from "./chain/adapter.js";
export {
    type Eip1193ProviderLike,
    Eip1193Signer,
    type EthSigner,
    PrivateKeySigner,
} from "./chain/eth-signer.js";
export {
    NETWORKS,
    type NetworkName,
    type NetworkPreset,
    resolveNetwork,
} from "./chain/networks.js";
export {
    ViemChainAdapter,
    type ViemChainAdapterOpts,
} from "./chain/viem-adapter.js";
// ── crypto primitives ────────────────────────────────────────────────────
export {
    BABYJUB_SUBGROUP_ORDER,
    buildNoteCommitment,
    buildNullifier,
    buildNullifierFromNsk,
    type Field,
    fromLeBytes,
    Jubjub,
    type MerkleProof,
    MerkleTree,
    type Point,
    Poseidon,
    toLeBytes,
} from "./crypto/index.js";
export {
    buildJubjub,
    configureJubjubWasm,
} from "./crypto/jubjub-wasm.js";
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
} from "./fmd/fmd.js";
// ── keys / addresses ─────────────────────────────────────────────────────
export {
    ADDRESS_HRP,
    type DecodedAddress,
    decodeAddress,
    encodeAddress,
} from "./keys/address.js";

export {
    generateMnemonic,
    isValidMnemonic,
    type KeySource,
    resolveNsk,
} from "./keys/key-source.js";
export {
    addressFromSpendingKey,
    buildSpendingKey,
    deriveKeysFromMnemonic,
    deriveKeysFromNsk,
    type FullViewingKey,
    fullViewingKeyFromSpending,
    type SpendingKey,
    type ViewingKey,
    viewingKeyFromSpending,
} from "./keys/keys.js";
export * as metamask from "./keys/metamask.js";
// ── notes (encoding, encryption, FMD aux) ────────────────────────────────
export { flagKeyFromAddressDk } from "./notes/aux.js";
export {
    encodeNotePayload,
    withClueBitsPrefix,
} from "./notes/codec.js";
export { decryptNote, encryptNote } from "./notes/encrypt.js";
export type { EncryptedNote, Note, SpentNote } from "./notes/note.js";

// ── prover backends ──────────────────────────────────────────────────────
export type { ProverArtifacts } from "./prover/artifacts.js";
export { type Prover, SnarkjsProver } from "./prover/interface.js";
export { nodeWallet } from "./prover/presets.js";
export {
    configureProver,
    type ProverPaths,
    prove,
    verify,
} from "./prover/snarkjs.js";
// `WasmProver` lives at `@lelantos-org/sdk/wasm-prover` so the main barrel
// does not pull in `wasm-bindgen-rayon` worker glue. Browser apps that opt
// out via `useWasmProver: false` pay zero bundle cost.
export {
    browserWorkerProver,
    WorkerProver,
} from "./prover/worker-client.js";
// ── relayer client ───────────────────────────────────────────────────────
export {
    RelayerClient,
    type SubmitSwapPayload,
    type SubmitTransactPayload,
} from "./relayer/client.js";
// ── sync engine ──────────────────────────────────────────────────────────
export {
    LocalScanner,
    type ScanHit,
    type ScanInput,
    type Scanner,
} from "./sync/scanner.js";
export { WorkerPoolScanner } from "./sync/scanner-worker-pool.js";
export { scanNotes } from "./sync/sync.js";

export { VERSION } from "./version.js";
// ── wallet (high-level orchestration) ────────────────────────────────────
export type { SyncStrategy, WalletConfig } from "./wallet/config.js";
export {
    type ConnectKeyOptions,
    type ConnectOptions,
    connect,
} from "./wallet/connect.js";
export {
    DepositAdapterError,
    type DepositStrategy,
    InsufficientCoverError,
    NetworkError,
    NetworkNotDeployedError,
    PermitRejectedError,
    ProverArtifactsMissingError,
    ProverError,
    SelectionError,
    TxMiningError,
    WalletConfigError,
    WalletError,
    type WalletErrorCode,
} from "./wallet/errors.js";
export {
    type CreateSubscriptionInput,
    FmdClient,
    type FmdMatchOut,
    type FmdNoteOut,
    type FmdPath,
    type FmdTreeState,
    type SubscriptionOut,
} from "./wallet/fmd-client.js";
export {
    type DepositOptions,
    type DepositResult,
    type NotesFilter,
    type SwapOptions,
    type SwapResult,
    safePhase,
    type TransactionResult,
    type TransferOptions,
    type TransferResult,
    Wallet,
    type WalletApi,
    type WalletNote,
    type WalletNotePayload,
    type WithdrawEthOptions,
    type WithdrawOptions,
    type WithdrawResult,
} from "./wallet/index.js";
export {
    FmdMatchesNoteSource,
    FmdNoteSource,
    type JubjubPacker,
    type ListNotesOpts,
    type NoteSource,
} from "./wallet/note-source.js";
export {
    addHits,
    decodeStoredNote,
    encodeStoredNote,
    findById,
    InMemoryNoteStore,
    markSpent,
    type NoteRecord,
    type NoteStore,
    type NotesFile,
    type StoredNote,
} from "./wallet/note-store.js";
export { randomFr } from "./wallet/randomness.js";
export {
    type CoinSelector,
    type ConsolidateFirst,
    type DirectSelection,
    type SelectionResult,
    type SelectOpts,
    SfrtCoinSelector,
} from "./wallet/selection.js";
export {
    HttpRelayerSubmitter,
    type Submitter,
} from "./wallet/submitter.js";
export {
    type SyncDeps,
    type SyncProgress,
    type SyncResult,
    syncWallet,
} from "./wallet/sync.js";
