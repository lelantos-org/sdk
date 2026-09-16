// What an operation will cost, computed before running it.
//
// Quotes are plain frozen data: no methods, safe to hold in a UI cache. Every figure is computed by
// the same code the operation runs, so a quote and its execution cannot disagree.

import type { CircuitAmount, EvmAddress, ShieldedAddress, TokenAmount } from "../../core/brand.js";
import type { DepositStrategy } from "../../errors/chain.js";
import type { AssetInfo } from "../assets/info.js";
import type { FeeBreakdown, Money } from "./results.js";

// --- relayer fee ---------------------------------------------------------------------------------

/** Which operation a relayer fee is quoted for. */
export type FeeKind = "transfer" | "withdraw" | "swap" | "deposit";

/** One asset the relayer accepts for a fee. */
export interface FeeOption {
    asset: AssetInfo;
    /** The fee note's value, exact. */
    amount: CircuitAmount;
    /**
     * `amount` in base units, at the asset's display index. For a deposit's authoritative pull use
     * `DepositQuote.fees.relayer`.
     */
    baseUnits: TokenAmount;
    /**
     * Spends: this wallet's unspent shielded balance of the asset. `undefined` for `kind: "deposit"`,
     * whose fee is funded from the public wallet (see `DepositQuote.pulls`).
     */
    balance: CircuitAmount | undefined;
    /**
     * `balance >= amount`: necessary, not sufficient (the notes must also fit the input slots;
     * `spendableMax` answers that). `undefined` for `kind: "deposit"`.
     */
    affordable: boolean | undefined;
}

export interface FeeQuote {
    kind: FeeKind;
    /** `false`: relayed for free; `feeAsset` is ignored and `options` is empty. */
    charged: boolean;
    /** The relayer's shielded fee address, when charging. */
    payTo?: ShieldedAddress | undefined;
    /** Accepted assets that resolve in the registry, lowest id first. */
    options: FeeOption[];
}

// --- deposit -------------------------------------------------------------------------------------

/** The Permit2 AllowanceTransfer state for one token, as a deposit's strategy choice reads it. */
export interface TokenAllowanceState {
    /** ERC-20 → Permit2 approval, base units. */
    erc20: bigint;
    /** Permit2 → pool window. */
    window: { amount: bigint; expiration: number; nonce: number };
    /**
     * Both cover this deposit's `ceiling` with the expiry buffer to spare: the allowance path is
     * usable for this token without setup.
     */
    covers: boolean;
}

/** What a deposit pulls of one ERC-20. Pulls of two asset ids over one token are summed. */
export interface DepositPull {
    /** The first asset naming the token: the deposited one where the fee shares its token. */
    asset: AssetInfo;
    token: EvmAddress;
    /** Base units the pool pulls: principal + protocol fee and/or the relayer's note. */
    amount: TokenAmount;
    /**
     * What is signed and checked against allowances: `amount` plus yield headroom on a yield asset
     * (the pool's rate grows every block), `amount` otherwise. The pool never pulls more than
     * `amount`.
     */
    ceiling: TokenAmount;
    /** Public balance (native balance on the native path); `undefined` when unreadable. */
    balance: TokenAmount | undefined;
    /** `undefined` on the native path, or when the adapter cannot read Permit2 state. */
    allowance: TokenAllowanceState | undefined;
}

/**
 * What `deposit(args)` would pull, charge and do right now.
 *
 * Covers the per-token figures a deposit form sizes balances and Permit2 setup against, so a UI
 * does not recombine `depositTotals` and `depositPulls` itself.
 *
 * Rejects as `deposit` would before signing: `FEE_ASSET_NOT_QUOTED`, `INVALID_ARGUMENT` for a refused
 * fee asset or a bad amount, `UNSUPPORTED_OPERATION` for `native` without an adapter.
 */
export interface DepositQuote {
    readonly kind: "depositQuote";
    asset: AssetInfo;
    /** The asset paying the relayer: `asset` unless another was chosen. */
    feeAsset: AssetInfo;
    native: boolean;
    /** The principal: the new note's value. */
    amount: Money;
    /** Protocol fee in `asset` (charged on top), relayer fee in `feeAsset`. */
    fees: FeeBreakdown;
    /** `amount + fees.protocol` in base units of `asset`: what the principal's pull is sized to. */
    principal: TokenAmount;
    /** Per distinct token, the deposited token first. One entry unless the fee's token differs. */
    pulls: DepositPull[];
    /** The pool pulls the relayer's note on its own (a two-entry batch permit). */
    separateFee: boolean;
    /** The fee draws on the deposited token's balance and allowance (`pulls.length === 1`). */
    feeSharesToken: boolean;
    /** The path `deposit` would take now: `native`, `allowance` (every pull covered) or `witness`. */
    strategy: DepositStrategy;
    /**
     * Not native, the adapter supports AllowanceTransfer, and some pull's allowance does not cover
     * it: `setupDepositAllowance` would move later deposits onto the `allowance` path.
     */
    allowanceSetupAvailable: boolean;
    /** Every pull's `balance` is known and covers its `amount`; `undefined` when one is unknown. */
    sufficientBalance: boolean | undefined;
    /** Unix seconds. Yield figures drift with the pool's rate; re-quote rather than cache long. */
    quotedAt: number;
}

// --- swap ----------------------------------------------------------------------------------------

/** A swap's charges. The two protocol fees fall on different legs and assets. */
export interface SwapFees extends FeeBreakdown {
    /** Leg 1's withdraw fee, in `assetIn`, taken out of `gross`. */
    protocol: Money | null;
    /** The relayer's spend fee, in the quoted fee asset. Paid from notes; not inside `gross`. */
    relayer: Money | null;
    /** The relayer's fee for flushing leg 2's deposit, in `assetOut`; inside the output pull. */
    flush: Money | null;
    /** Leg 2's deposit fee, in `assetOut`; inside the output pull. */
    outProtocol: Money | null;
}

/**
 * A priced swap, produced by `quoteSwap` and passed back to `swap`.
 *
 * Treat as opaque data: `swap` re-resolves both assets, re-derives the amounts and binds `route`,
 * `minOut` and `credit` into the proof. A quote it could not have produced is `INVALID_ARGUMENT`;
 * one whose figures moved since (a yield index, the relayer's flush fee) is `QUOTE_STALE`,
 * retryable by re-quoting. Otherwise staleness is the caller's policy (`quotedAt`); the chain
 * enforces `minOut`.
 */
export interface SwapQuote {
    readonly kind: "swapQuote";
    assetIn: AssetInfo;
    assetOut: AssetInfo;
    /** Which side the caller named. */
    side: "gross" | "net";
    /** `publicOut` leaving the pool in `assetIn`. */
    gross: Money;
    /** What reaches the venue: `gross − fees.protocol`. `net.baseUnits` is the venue's `amountIn`. */
    net: Money;
    /** Whether `gross` is a denomination of `assetIn` (it is published on-chain). */
    onLadder: boolean;
    slippageBps: number;
    /** The venue's expected output, base units of `assetOut`. */
    expectedOut: TokenAmount;
    /** `expectedOut` less slippage: the floor the wrapper enforces. */
    minOut: TokenAmount;
    /**
     * Exactly what the output note will hold if the swap fills (not a floor: a better fill goes to
     * the treasury). Net of `fees.flush` and `fees.outProtocol`.
     */
    credit: Money;
    /** What the refund note would hold, in `assetIn`, if the swap fails or passes its deadline. */
    refundCredit: Money;
    fees: SwapFees;
    /** Venue label for display, e.g. `"univ3"`. */
    venue: string;
    /** Unix seconds the venue was queried. */
    quotedAt: number;
    /**
     * The venue route `swap` binds into the proof: the allowlisted `ISwapAdapter` and its encoded
     * path. Readable for display and diagnostics; do not construct or edit (the wrapper refuses a
     * non-allowlisted adapter on chain, and `swap` checks the shape).
     */
    readonly route: { readonly adapter: EvmAddress; readonly path: `0x${string}` };
}
