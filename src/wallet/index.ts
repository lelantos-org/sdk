export { type AmountLike, resolveAmount } from "./amount.js";
export { type AssetRef, classifyRef, matchRef, type RefKind } from "./asset-ref.js";
export { AssetRegistry, type AssetRegistrySource } from "./asset-registry.js";
export {
    canDeposit,
    type DepositCapableWallet,
    type DepositContext,
    type NativeDepositWallet,
    supportsDeposit,
    supportsNativeDeposit,
} from "./capability.js";
// Chunk paging is how both the tree and the nullifier set catch up, and both
// summaries report a `PagingStop`. `MAX_CHUNKS` is the default bound.
export { MAX_CHUNKS, maxChunksFor, type PagingOpts, type PagingStop } from "./chunk-feed.js";
export { type FeeOption, type FeeQuoteResult, type QuoteFeeArgs, quoteFee } from "./fee-quote.js";
// The wallet: the orchestration layer most callers use directly.
//
// Every pluggable dependency (ChainAdapter, NoteSource, Submitter, Prover,
// CoinSelector, NoteStore, TreeStore, Scanner) is exported here: swapping one
// is a supported use, and any type appearing in an exported signature must be
// nameable by the caller.

export type {
    DepositOptions,
    DepositPhase,
    DepositResult,
    NotesFilter,
    OnPhase,
    ReadOnlyWalletApi,
    SpendPhase,
    SwapOptions,
    SwapResult,
    TransactionResult,
    TransferOptions,
    TransferResult,
    WalletApi,
    WalletNote,
    WalletNotePayload,
    WithdrawEthOptions,
    WithdrawOptions,
    WithdrawResult,
} from "./api.js";
export {
    type AssetInfo,
    type AssetInfoWithMeta,
    denominations,
    fetchAssetInfo,
    formatAmount,
    hasTokenMeta,
    isDenominated,
    isOnLadder,
    type MakeAssetInfoArgs,
    makeAssetInfo,
    minAmount,
    nearestDenomination,
    parseAmount,
    requireTokenMeta,
    withdrawNetFor,
} from "./assets/index.js";
export type { ResolvedWalletConfig, SyncStrategy, WalletConfig } from "./config.js";
export {
    type ConnectChainOptions,
    type ConnectExtraOptions,
    type ConnectKeyOptions,
    type ConnectOptions,
    connect,
} from "./connect/index.js";
// `ConsolidateHost`, `SpendContext`, `SyncContext` and `RedenominateHost` are
// the capability interfaces the wallet satisfies for its own operations.
// `Wallet` is exported with methods typed against them, so a caller cannot
// name those signatures without them.
export type { ConsolidateHost } from "./consolidate.js";
export { DEFAULT_ASSET } from "./constants.js";
export type { SpendContext } from "./context.js";
export {
    type AwaitCommitmentsOpts,
    type AwaitCommitmentsResult,
    awaitCommitments,
    NoteCache,
} from "./note-cache.js";
export {
    FmdMatchesNoteSource,
    FmdNoteSource,
    type ListNotesOpts,
    type NotePage,
    type NoteSource,
} from "./note-source.js";
export {
    addHits,
    type ConsolidateHint,
    decodeStoredNote,
    InMemoryNoteStore,
    type NoteRecord,
    type NoteStore,
    type NotesFile,
    type StoredNote,
} from "./note-store.js";
export {
    type NullifierPersistence,
    NullifierStore,
    type NullifierStoreState,
    type NullifierSyncOpts,
    type NullifierSyncSummary,
} from "./nullifier-store.js";
export type { RedenominateHost } from "./redenominate.js";
export {
    type CoinSelector,
    type ConsolidateFirst,
    DenominationCoinSelector,
    type DirectSelection,
    type SelectionResult,
    type SelectOpts,
    SfrtCoinSelector,
    type SpendableMax,
    type WithheldValue,
} from "./selection/index.js";
export { type EstimateKind, HttpRelayerSubmitter, type Submitter } from "./submitter.js";
export { sizeBNote } from "./swap.js";
export {
    type NoteSink,
    type SyncDeps,
    type SyncOpts,
    type SyncProgress,
    type SyncResult,
    type SyncStop,
    syncWallet,
} from "./sync.js";
// `SyncContext.nullifiers` is a `NullifierMemo`, so the context cannot be
// assembled without it.
export { NullifierMemo, type SyncContext } from "./sync-ops.js";
export {
    type MerkleNode,
    type RootCheck,
    type TreePersistence,
    TreeStore,
    type TreeStoreState,
    type TreeSyncOpts,
    type TreeSyncSummary,
    type TreeVerifyOpts,
} from "./tree-store.js";
export { Wallet } from "./wallet.js";
export {
    type DenominationChoice,
    denominationChoices,
    previewWithdraw,
    type WithdrawPreview,
    type WithdrawPreviewArgs,
} from "./withdraw-preview.js";
