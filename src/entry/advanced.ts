// `@lelantos-org/sdk/advanced`: integrator plumbing behind `connect()`.
//
// `createWallet(KeySource, WalletConfig)` with hand-built pluggables: chain ports and the viem
// adapter, signers, the relayer submitter, note stores and sources, tree/nullifier persistence, coin
// selectors and scanners. Semver-covered, but expect wider changes than the root surface.

export { isNetworkDeployed, resolveNetwork } from "../chain/networks.js";
export {
    locateOperation,
    NOTE_PAYLOAD_TOPIC,
    NULLIFIER_CONSUMED_TOPIC,
    ROOT_ADVANCED_TOPIC,
} from "../chain/operation.js";
export {
    type AllowanceBatchChain,
    type AllowanceTransferChain,
    type ChainAdapter,
    type ChainReader,
    type NativeEthChain,
    supportsAllowanceBatch,
    supportsAllowanceTransfer,
    supportsNativeEth,
    supportsSigning,
} from "../chain/port.js";
export { Eip1193Signer } from "../chain/signer/eip1193.js";
export { PrivateKeySigner } from "../chain/signer/private-key.js";
export type {
    AssetEntry,
    CancelDepositInputs,
    CancelDepositReceipt,
    DepositEscrowedRecord,
    DepositSubmitted,
    EscrowedDepositView,
    Permit2SignArgs,
    TokenMeta,
    TxLog,
} from "../chain/types.js";
export { MASP_ABI, NATIVE_ADAPTER_ABI } from "../chain/viem/abi.js";
export type { ViemReadCtx } from "../chain/viem/ctx.js";
export { ViemChainAdapter, type ViemChainAdapterOpts } from "../chain/viem/index.js";
export { ViemChainReader, type ViemChainReaderOpts } from "../chain/viem/reader.js";
export { requestPersistentStorage } from "../core/storage.js";
export type { TypedDataDomain, TypedDataParameter } from "../crypto/eip712.js";
export type { MerkleNode } from "../crypto/merkle.js";
export type { WalletErrorOptions } from "../errors/base.js";
export { type KeySource, resolveNsk } from "../keys/key-source.js";
export { loggingFromEnv } from "../log/env.js";
export { loggingConfig } from "../log/logger.js";
export type { NoteRecord, NotesFile, StoredNote } from "../protocol/note-record.js";
export {
    type EstimateKind,
    HttpRelayerSubmitter,
    type Submitter,
} from "../services/relayer/submitter.js";
export type { PagingOpts, PagingStop } from "../sync/chunk-feed.js";
export {
    FmdMatchesNoteSource,
    FmdNoteSource,
    type ListNotesOpts,
    type NotePage,
    type NoteSource,
} from "../sync/note-source.js";
export {
    type NullifierFeed,
    type NullifierPersistence,
    NullifierStore,
    type NullifierStoreState,
    type NullifierSyncOpts,
    type NullifierSyncSummary,
} from "../sync/nullifier-store.js";
export {
    emptyScanStats,
    type ScanHit,
    type ScanInput,
    type ScanStats,
    scanNotes,
} from "../sync/scan.js";
export { LocalScanner, type Scanner } from "../sync/scanner.js";
export {
    type CommitmentFeed,
    type RootCheck,
    type TreePersistence,
    TreeStore,
    type TreeStoreState,
    type TreeSyncOpts,
    type TreeSyncSummary,
    type TreeVerifyOpts,
} from "../sync/tree-store.js";
export {
    type BrowserWorkerScannerOpts,
    browserWorkerScanner,
    WorkerPoolScanner,
    type WorkerPoolScannerOpts,
} from "../sync/worker/pool.js";
export { type OutAmountSide, outAmount, outAmountSide } from "../wallet/assets/amount.js";
export {
    type AssetInfoWithMeta,
    fetchAssetInfo,
    hasTokenMeta,
    type MakeAssetInfoArgs,
    makeAssetInfo,
    requireTokenMeta,
} from "../wallet/assets/info.js";
export { createWallet } from "../wallet/create.js";
export { InMemoryNoteStore, type NoteStore } from "../wallet/notes/note-store.js";
export {
    denominationChoices,
    previewWithdraw,
    type WithdrawPreviewArgs,
} from "../wallet/ops/withdraw-preview.js";
export { DenominationCoinSelector } from "../wallet/selection/denomination.js";
export { SfrtCoinSelector } from "../wallet/selection/sfrt.js";
export type {
    CoinSelector,
    ConsolidateFirst,
    DirectSelection,
    SelectionResult,
    SelectOpts,
} from "../wallet/selection/types.js";
export {
    type DepositCapableWallet,
    type NativeDepositWallet,
    supportsDeposit,
    supportsNativeDeposit,
} from "../wallet/types/capability.js";
export type { ResolvedWalletConfig, SyncStrategy, WalletConfig } from "../wallet/types/config.js";
export type { ResultBase } from "../wallet/types/results.js";
export type { ResolvedWatchConfig, WatchWalletConfig } from "../wallet/watch/config.js";
export { createWatchWallet } from "../wallet/watch/watch-wallet.js";
