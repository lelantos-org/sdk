// Operation results and note views.
//
// Results are plain frozen data. Every value-bearing figure is a `Money`, so a receipt names its
// asset and both integer spaces instead of leaving the caller to convert with the right index.

import type { OperationLocation } from "../../chain/operation.js";
import type { CancelDepositInputs } from "../../chain/types.js";
import type {
    AssetId,
    CircuitAmount,
    EvmAddress,
    Hex32,
    ShieldedAddress,
    TokenAmount,
} from "../../core/brand.js";
import type { DepositStrategy } from "../../errors/chain.js";
import type { AssetInfo } from "../assets/info.js";

export type { DepositStrategy, OperationLocation };

/**
 * Plaintext payload of a recovered note, for custom proofs with the low-level builders.
 */
export interface WalletNotePayload {
    asset: AssetId;
    value: CircuitAmount;
    rho: bigint;
    rcm: bigint;
    rcvDep: bigint;
}

/** Note view returned by `wallet.notes()`. */
export interface WalletNote {
    id: string;
    asset: AssetId;
    value: CircuitAmount;
    spent: boolean;
    firstSeenBlock?: number;
    /** ISO-8601. */
    discoveredAt: string;
    cm: Hex32;
    /** Decoded payload. Recomputes on each call. */
    notePayload(): WalletNotePayload;
}

/**
 * An amount of one asset in both integer spaces.
 *
 * Which field is authoritative follows where the figure lives:
 * - shielded figures (note values, `publicIn`/`publicOut`, unit-denominated yield fees): `amount`
 *   is exact and `baseUnits` is its conversion at the asset's rate;
 * - public figures (pulls, refunds, net received, plain-asset protocol fees): `baseUnits` is exact
 *   and `amount` is `fromBaseUnits(baseUnits, { round: "down" })`, for display.
 */
export interface Money {
    asset: AssetId;
    amount: CircuitAmount;
    baseUnits: TokenAmount;
}

/**
 * The two parties an operation pays. `null` means not charged at all (zero rate, or relayed for
 * free); a zero-valued `Money` never appears.
 */
export interface FeeBreakdown {
    /** The pool's fee: on top of a deposit, out of a withdrawal's gross. */
    protocol: Money | null;
    /** The relayer's fee note, in the asset that paid it. */
    relayer: Money | null;
}

/** Fields every shielded operation's result carries. `kind` discriminates. */
export interface ResultBase<K extends string> {
    kind: K;
    /** The id `onPhase` and any error for this call carried. */
    opId: string;
    /** The asset moved (a swap's `assetIn`). */
    asset: AssetInfo;
    txHash: Hex32;
    /** Every output commitment, in slot order. Slots are shuffled; use the named fields. */
    commitments: Hex32[];
    /** The subset this wallet will recover by scanning (change, own deposits). */
    ownCommitments: Hex32[];
    /** The subset with non-zero value; zero-value outputs are padding. */
    nonZeroCommitments: Hex32[];
    fees: FeeBreakdown;
    /**
     * Where this operation sits in `txHash`, which a relayer bundle may share. Absent when the
     * receipt could not be read; the operation still succeeded.
     */
    operation?: OperationLocation | undefined;
}

/**
 * An escrowed deposit, pending the relayer's flush.
 *
 * Plain data (bigints, strings, numbers): persist it with a bigint-aware serialiser to cancel or
 * await after a reload.
 */
export interface DepositEscrow {
    depositId: bigint;
    /** Owned by `NativeAdapter`; `cancelDeposit` routes through it. */
    native: boolean;
    asset: AssetId;
    /** The new note's commitment: what `awaitDeposit` waits for. Equals `cancelInputs.cm`. */
    commitment: Hex32;
    /** The `DepositEscrowed` payload the pool re-derives the escrow digest from. */
    cancelInputs: CancelDepositInputs;
    /** First block at which `cancelDeposit` is accepted: escrow block + `cancelDelay`. */
    cancellableAtBlock: number;
}

export interface DepositResult extends ResultBase<"deposit"> {
    /** The new note's value (`publicIn`). */
    amount: Money;
    strategy: DepositStrategy;
    native: boolean;
    /** Owner of the new note. */
    recipient: ShieldedAddress;
    /**
     * What the pool pulled, per asset as the permit names them: the deposited asset first, then the
     * fee asset when its note was pulled on its own. `baseUnits` exact.
     */
    pulled: Money[];
    escrow: DepositEscrow;
}

export interface TransferResult extends ResultBase<"transfer"> {
    /** The recipient note's value. */
    amount: Money;
    recipient: ShieldedAddress;
    /** The commitment holding the recipient's note; safe to share with them. */
    recipientCommitment: Hex32;
    /** Note ids consumed, across both assets when the fee was cross-asset. */
    spent: string[];
    /** Change left in `asset`. */
    change: CircuitAmount;
}

export interface WithdrawResult extends ResultBase<"withdraw"> {
    /** `publicOut`, published on-chain. */
    gross: Money;
    /** Delivered to `recipient`: `gross − fees.protocol`. `baseUnits` exact. */
    net: Money;
    recipient: EvmAddress;
    native: boolean;
    /** Whether `gross` is a denomination. `false` makes the withdrawal linkable; surface it. */
    onLadder: boolean;
    spent: string[];
    change: CircuitAmount;
}

export interface SwapResult extends ResultBase<"swap"> {
    assetOut: AssetInfo;
    gross: Money;
    /** Sent to the venue. */
    net: Money;
    onLadder: boolean;
    /** The output note's value if the swap fills: the quote's `credit`. */
    expectedCredit: Money;
    /** The refund note's value if it does not. */
    refundCredit: Money;
    /** Commitment of the output note; await it with `awaitCommitments`. */
    creditCommitment: Hex32;
    /** Commitment of the refund note. Exactly one of the two lands. */
    refundCommitment: Hex32;
    /** Unix seconds after which the wrapper refunds instead of swapping. */
    deadline: bigint;
    spent: string[];
    change: CircuitAmount;
}

/** Every shielded operation's result. Switch on `kind`. */
export type TransactionResult = DepositResult | TransferResult | WithdrawResult | SwapResult;

/** What `cancelDeposit` refunded, from the pool's `DepositCanceled` log. */
export interface CancelDepositResult {
    kind: "cancelDeposit";
    opId: string;
    txHash: Hex32;
    depositId: bigint;
    native: boolean;
    /** In the deposit asset: principal, protocol fee, and the relayer's share when paid in it. */
    refunded: Money;
    /** In the fee asset, when the relayer's note was paid in another asset; else `null`. */
    feeRefunded: Money | null;
}
