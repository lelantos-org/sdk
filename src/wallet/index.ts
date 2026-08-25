export { type AmountLike, resolveAmount } from "./amount.js";
export { type AssetRef, classifyRef, matchRef } from "./asset-ref.js";
export { AssetRegistry, type AssetRegistrySource } from "./asset-registry.js";
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
    fetchAssetInfo,
    formatAmount,
    hasTokenMeta,
    minAmount,
    parseAmount,
    requireTokenMeta,
} from "./assets.js";
export type { SyncStrategy, WalletConfig } from "./config.js";
export {
    type ConnectChainOptions,
    type ConnectExtraOptions,
    type ConnectKeyOptions,
    type ConnectOptions,
    connect,
} from "./connect/index.js";
export { DEFAULT_ASSET } from "./constants.js";
export { type AwaitCommitmentsOpts, awaitCommitments, NoteCache } from "./note-cache.js";
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
export {
    type CoinSelector,
    type ConsolidateFirst,
    type DirectSelection,
    type SelectionResult,
    type SelectOpts,
    SfrtCoinSelector,
} from "./selection.js";
export { HttpRelayerSubmitter, type Submitter } from "./submitter.js";
export { sizeBNote } from "./swap.js";
export {
    type NoteSink,
    type SyncDeps,
    type SyncOpts,
    type SyncProgress,
    type SyncResult,
    syncWallet,
} from "./sync.js";
export {
    type MerkleNode,
    type TreePersistence,
    TreeStore,
    type TreeStoreState,
} from "./tree-store.js";
export { Wallet } from "./wallet.js";
