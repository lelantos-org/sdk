// Wallet operation options. Re-exported from `./api.ts` and the public barrel.

import type { SwapQuote } from "../bundle/swap-quote.js";
import type { SelectOpts } from "./selection.js";

export type DepositPhase = "signing" | "submitting" | "broadcast" | "mined";
export type SpendPhase = "preparing" | "proving" | "submitting";

/// Phase callback shape used by every spend-side operation.
export type OnPhase<P extends string> = (phase: P) => void;

/// Shield ERC-20 into the MASP. For native ETH, set `asEth: true`.
export interface DepositOptions {
    /// Amount in circuit units (post-scale-down).
    amount: bigint;
    /// Default 1n.
    asset?: bigint;
    /// Shielded recipient (bech32m). Defaults to own address.
    to?: string;
    /// Unix-seconds. Default `now + 3600`.
    deadline?: bigint;
    /// Native-ETH deposit. Requires the registered WETH asset id; SDK
    /// calls `submitIntentNative` with `msg.value = total`.
    asEth?: boolean;
    /// Errors from callback are swallowed.
    onPhase?: OnPhase<DepositPhase>;
}

/// Unshield WETH note to raw ETH via `MASP.withdrawEth`. Asset id MUST
/// be registered against the chain's WETH.
export interface WithdrawEthOptions {
    to: string;
    amount: bigint;
    /// Asset id of WETH in the MASP registry.
    asset: bigint;
    selectOpts?: SelectOpts;
    /// Self-spend then retry on `InsufficientCoverError`.
    autoConsolidate?: boolean;
    onPhase?: OnPhase<SpendPhase>;
}

/// Shielded transfer. Throws `InsufficientCoverError` if no 1- or 2-note
/// cover exists, unless `autoConsolidate: true`.
export interface TransferOptions {
    /// Recipient bech32m shielded address.
    to: string;
    amount: bigint;
    /// Default 1n.
    asset?: bigint;
    selectOpts?: SelectOpts;
    autoConsolidate?: boolean;
    onPhase?: OnPhase<SpendPhase>;
}

/// Unshield to ERC20. For native ETH use `withdrawEth`. Throws
/// `InsufficientCoverError` on no cover, unless `autoConsolidate: true`.
export interface WithdrawOptions {
    to: string;
    amount: bigint;
    /// Default 1n.
    asset?: bigint;
    selectOpts?: SelectOpts;
    autoConsolidate?: boolean;
    onPhase?: OnPhase<SpendPhase>;
}

/// Atomic shielded swap via SwapWrapper.
export interface SwapOptions {
    assetIn: bigint;
    assetOut: bigint;
    /// Gross publicOut in circuit units of `assetIn`. MASP transfers
    /// `amount * scaleIn` minus protocol fee to the wrapper.
    amount: bigint;
    /// Pre-fetched MetaQuoter quote pinning route + minOut.
    quote: SwapQuote;
    /// SwapWrapper address; bound as leg-1 recipient+relayer and leg-2 payer.
    wrapperAddress: string;
    /// Shielded recipient for B note. Defaults to own.
    bRecipient?: string;
    selectOpts?: SelectOpts;
    autoConsolidate?: boolean;
    onPhase?: OnPhase<SpendPhase>;
}

/// `asset` is required so multi-asset callers can't read across assets.
export interface NotesFilter {
    asset: bigint;
    spent?: boolean;
}
