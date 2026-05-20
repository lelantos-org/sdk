// Public barrel for the `wallet` subpath. The `Wallet` class lives in
// `./wallet.ts`; per-tx helpers live in `./{deposit,transfer,withdraw,swap}.ts`.

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
export type { TreePersistence, TreeStoreState } from "./tree-store.js";
export { TreeStore } from "./tree-store.js";
export { safePhase, Wallet } from "./wallet.js";
