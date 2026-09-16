// Coin selection types: request options, results, and the strategy interface.
// Kept separate from the algorithms so type-only importers pull in no code.

import type { AssetId, CircuitAmount } from "../../core/brand.js";
import type { StoredNote } from "../notes/note-store.js";

/**
 * Blocks a note must age before it becomes spendable.
 *
 * One block defeats the same-block change-link heuristic: a change note spent
 * in the block that created it links the two spends. Higher values widen the
 * window at the cost of delaying spends of newly received notes.
 */
export const DEFAULT_COOLDOWN_BLOCKS = 1;

export interface SelectOpts {
    /** Cover threshold becomes `target + fee`. Default 0. */
    fee?: bigint | undefined;
    /** Notes with value < dustThreshold are excluded. Recommended: `2 * marginalFee`. */
    dustThreshold?: bigint | undefined;
    /**
     * Minimum age in blocks before a note is spendable. Defaults to
     * `DEFAULT_COOLDOWN_BLOCKS`. Requires `tipBlock` and per-note
     * `firstSeenBlock`; inert otherwise.
     */
    cooldownBlocks?: number | undefined;
    /**
     * Chain tip. `runSpend` supplies it from `ChainAdapter.blockNumber()`;
     * an adapter without that method leaves the cooldown inert.
     */
    tipBlock?: number | undefined;
    /** Tiebreak shuffle width: notes within `(1 ± bucketPct) * pivot`. Default 0.05. */
    bucketPct?: number | undefined;
    /**
     * Maximum notes a single spend may consume (the circuit's `nIn`). Defaults
     * to `DEFAULT_SHAPE.nIn`; `runSpend` passes the configured shape's arity.
     */
    maxInputs?: number | undefined;
    /**
     * Restrict candidates to these note ids.
     *
     * Used by consolidation. Selecting by amount does not pin the notes: SFRT
     * returns the smallest-sum cover, and a single note valued between the
     * target and the dust set's total is a cheaper cover than the dust set, so
     * the merge would not consolidate anything.
     *
     * Applied in addition to the other spendability rules: a named id that is
     * spent, reserved or cooling down stays excluded.
     */
    only?: readonly string[] | undefined;
    /**
     * Injectable randomness for tests: returns a uniform integer in `[0, n)`.
     *
     * An integer picker rather than a float: scaling a float over `n` buckets
     * is non-uniform unless `n` is a power of two, and a skew in which note is
     * picked is the fingerprint the tiebreak defends against. Defaults to
     * `randomBelow` from `@lelantos-org/sdk/primitives`.
     */
    pick?: ((n: number) => number) | undefined;
}

export interface DirectSelection {
    plan: "direct";
    notes: StoredNote[];
    sum: CircuitAmount;
}

export interface ConsolidateFirst {
    plan: "consolidate-first";
    /**
     * The smallest spendable notes, up to the circuit's input arity — the
     * caller self-spends them into one, then retries after a sync.
     */
    consolidate: StoredNote[];
    consolidateSum: CircuitAmount;
    /** `target + fee`. */
    targetWithFee: CircuitAmount;
}

export type SelectionResult = DirectSelection | ConsolidateFirst;

/**
 * Value held back from a spend, by the rule that held it.
 *
 * Plain `bigint`: `CircuitAmount` is a subtype of `bigint`, so a union with it
 * would erase the brand.
 */
export interface WithheldValue {
    /** Reserved by a submit whose outcome was never confirmed. */
    reserved: bigint;
    /** Below the dust threshold. */
    dust: bigint;
    /** Too recently seen to have cleared the spend cooldown. */
    cooldown: bigint;
    /**
     * Spendable, but beyond the circuit's input arity.
     *
     * Resolved by consolidation rather than time. It depends on `maxInputs`, so
     * `partitionSpendable` leaves it `0n` and `WalletApi.spendableMax` fills it in.
     */
    slots: bigint;
}

/** Pluggable selection strategy passed via `WalletConfig.selector`. */
export interface CoinSelector {
    select(
        all: readonly StoredNote[],
        asset: AssetId,
        target: CircuitAmount,
        opts?: SelectOpts,
    ): SelectionResult;
}

/** What one spend of an asset can reach, and what is holding the rest back. */
export interface SpendableMax {
    /** Largest amount a single spend can cover, after `reserve`. */
    max: CircuitAmount;
    /**
     * Value the balance counts but this spend cannot reach, by cause.
     *
     * `slots` covers spendable notes beyond the circuit's input arity: a balance
     * spread across more than `maxInputs` notes has a remainder no single spend
     * can reach. Consolidation recovers it; the other causes resolve over time.
     */
    withheld: WithheldValue;
}
