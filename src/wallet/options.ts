// Wallet operation options. Re-exported from `./api.ts` and the public barrel.

import type { AssetId, CircuitAmount, EvmAddress, ShieldedAddress } from "../core/brand.js";
import type { SwapQuote } from "../services/quoter/client.js";
import type { SelectOpts } from "./selection.js";

export type DepositPhase = "signing" | "submitting" | "broadcast" | "mined";
export type SpendPhase = "preparing" | "proving" | "submitting";

/** Phase callback shape used by every spend-side operation. */
export type OnPhase<P extends string> = (phase: P) => void;

/** Shield ERC-20 into the MASP. For native ETH, set `asEth: true`. */
export interface DepositOptions {
    /** Amount in circuit units (post-scale-down). */
    amount: CircuitAmount;
    /** Default asset 1. */
    asset?: AssetId | undefined;
    /** Shielded recipient. Defaults to own address. */
    to?: ShieldedAddress | undefined;
    /** Unix-seconds. Default `now + 3600`. */
    deadline?: bigint | undefined;
    /**
     * Native-ETH deposit. Requires the registered WETH asset id; SDK
     * calls `NativeAdapter.depositNative` with `msg.value = total`.
     */
    asEth?: boolean | undefined;
    /** Errors from callback are swallowed. */
    onPhase?: OnPhase<DepositPhase> | undefined;
}

/**
 * Unshield WETH note to raw ETH via `MASP.withdrawEth`. Asset id MUST
 * be registered against the chain's WETH.
 */
export interface WithdrawEthOptions {
    /** L1 recipient of the unwrapped ETH. */
    to: EvmAddress;
    amount: CircuitAmount;
    /** Asset id of WETH in the MASP registry. */
    asset: AssetId;
    selectOpts?: SelectOpts | undefined;
    /** Self-spend then retry on `InsufficientCoverError`. */
    autoConsolidate?: boolean | undefined;
    onPhase?: OnPhase<SpendPhase> | undefined;
}

/**
 * Shielded transfer. Throws `InsufficientCoverError` if no 1- or 2-note
 * cover exists, unless `autoConsolidate: true`.
 */
export interface TransferOptions {
    /** Recipient shielded address. */
    to: ShieldedAddress;
    amount: CircuitAmount;
    /** Default asset 1. */
    asset?: AssetId | undefined;
    selectOpts?: SelectOpts | undefined;
    autoConsolidate?: boolean | undefined;
    onPhase?: OnPhase<SpendPhase> | undefined;
}

/**
 * Unshield to ERC20. For native ETH use `withdrawEth`. Throws
 * `InsufficientCoverError` on no cover, unless `autoConsolidate: true`.
 */
export interface WithdrawOptions {
    /** L1 ERC-20 recipient. */
    to: EvmAddress;
    amount: CircuitAmount;
    /** Default asset 1. */
    asset?: AssetId | undefined;
    selectOpts?: SelectOpts | undefined;
    autoConsolidate?: boolean | undefined;
    onPhase?: OnPhase<SpendPhase> | undefined;
}

/** Atomic shielded swap via SwapWrapper. */
export interface SwapOptions {
    assetIn: AssetId;
    assetOut: AssetId;
    /**
     * Gross publicOut in circuit units of `assetIn`. MASP transfers
     * `amount * scaleIn` minus protocol fee to the wrapper.
     */
    amount: CircuitAmount;
    /** Pre-fetched MetaQuoter quote pinning route + minOut. */
    quote: SwapQuote;
    /** SwapWrapper address; bound as leg-1 recipient+relayer and leg-2 payer. */
    wrapperAddress: EvmAddress;
    /** Shielded recipient for B note. Defaults to own. */
    bRecipient?: ShieldedAddress | undefined;
    selectOpts?: SelectOpts | undefined;
    autoConsolidate?: boolean | undefined;
    onPhase?: OnPhase<SpendPhase> | undefined;
}

/** Every field is optional; an empty filter returns every known note. */
export interface NotesFilter {
    /** Omit to read across every asset. */
    asset?: AssetId | undefined;
    /** Omit to include both spent and unspent. */
    spent?: boolean | undefined;
}
