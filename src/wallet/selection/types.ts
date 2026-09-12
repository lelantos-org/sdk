// The vocabulary of coin selection: what a caller may ask for, what a selector
// may answer, and the strategy interface that joins the two.
//
// Split out from the algorithms so a module that only names a selection — the
// wallet API, the spend steps, the config — costs nothing but types.

import type { AssetId, CircuitAmount } from "../../core/brand.js";
import type { StoredNote } from "../note-store.js";

/**
 * Blocks a note must age before it becomes spendable.
 *
 * One block breaks the same-block change-link heuristic: a change note spent
 * in the block it was created in ties the two spends together for an observer
 * counting leaves. Higher values widen the window, at the cost of leaving a
 * just-received note briefly unspendable.
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
     * Chain tip. `prepareSpend` supplies it from `ChainAdapter.blockNumber()`;
     * an adapter without that method leaves the cooldown inert.
     */
    tipBlock?: number | undefined;
    /** Tiebreak shuffle width: notes within `(1 ± bucketPct) * pivot`. Default 0.05. */
    bucketPct?: number | undefined;
    /**
     * Most notes a single spend may consume — the circuit's `nIn`. Defaults to
     * `DEFAULT_SHAPE.nIn`; `prepareSpend` passes the configured shape's arity.
     */
    maxInputs?: number | undefined;
    /**
     * Restrict candidates to these note ids.
     *
     * Consolidation is what needs it. Asking by *amount* does not name the
     * notes: SFRT returns the smallest-*sum* cover of that amount, and any
     * single note whose value falls between the target and the dust set's
     * total is a cheaper cover than the dust set itself. When one exists the
     * merge silently does nothing, and the retry fails for the same reason as
     * the first attempt. Naming the ids removes the ambiguity.
     *
     * Applied alongside the other spendability rules, not instead of them: an
     * id named here that is spent, reserved or cooling down stays excluded.
     */
    only?: readonly string[] | undefined;
    /**
     * Injectable randomness for tests: returns a uniform integer in `[0, n)`.
     *
     * An integer picker rather than a float, because the tiebreak's whole job
     * is to be uniform — scaling a float over `n` buckets makes them unequal
     * unless `n` is a power of two, and the fingerprint this defends against is
     * exactly a skew in which note gets picked. Defaults to {@link randomBelow}.
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
 * Plain `bigint`, not `CircuitAmount`: the branded type is a subtype of
 * `bigint`, so a `CircuitAmount | bigint` union erases the brand and buys
 * nothing.
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
     * The odd one out: the other three need time, this one needs a
     * consolidation. `partitionSpendable` cannot see it — it depends on
     * `maxInputs` — so it stays `0n` until {@link spendableMax} fills it in.
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
     * `slots` is the one that surprises: even fully spendable notes are capped
     * at the circuit's input arity, so a balance spread across more notes than
     * `maxInputs` has a remainder no single spend can touch. It is not stuck —
     * consolidating merges it — where the other three simply need time.
     */
    withheld: WithheldValue;
}
