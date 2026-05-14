// Public barrel for the `wallet` subpath. The `Wallet` class lives in
// `./wallet.ts`; per-tx helpers live in `./{deposit,transfer,withdraw,swap}.ts`.

export type {
    DepositOptions,
    DepositResult,
    NotesFilter,
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
export { safePhase, Wallet, warmAssetGen } from "./wallet.js";
