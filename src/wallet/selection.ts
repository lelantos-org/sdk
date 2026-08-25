// Coin selector: SFRT — Smallest-First with Random Tiebreak.

import { type AssetId, branded, type CircuitAmount } from "../core/brand.js";
import { SelectionError } from "../core/errors.js";
import { randomBelow } from "../core/random.js";
import { DEFAULT_SHAPE } from "../core/shape.js";
import { getLogger } from "../log/logger.js";
import { type StoredNote, withinReservation } from "./note-store.js";

const log = getLogger("lelantos:wallet:selection");

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
 * Per-rule tally of notes excluded from a selection. Reported in the
 * `SelectionError` message, which otherwise cannot distinguish an empty wallet
 * from an all-dust, wrong-asset or fully-cooled-down one.
 */
interface RejectionCounts {
    spent: number;
    reserved: number;
    otherAsset: number;
    dust: number;
    cooldown: number;
}

/** Notes that survive every spendability rule, plus a tally of what did not. */
function partitionSpendable(
    all: readonly StoredNote[],
    asset: AssetId,
    rules: { dust: bigint; cooldown: number; tip: number | undefined; now: number },
): { candidates: StoredNote[]; rejected: RejectionCounts } {
    const rejected: RejectionCounts = {
        spent: 0,
        reserved: 0,
        otherAsset: 0,
        dust: 0,
        cooldown: 0,
    };
    const candidates: StoredNote[] = [];

    for (const n of all) {
        if (n.spent) {
            rejected.spent++;
        } else if (withinReservation(n.pendingSpendAt, rules.now)) {
            // A spend of this note is outstanding: it may already be spent,
            // and offering it again earns a duplicate rejection, not a tx.
            rejected.reserved++;
        } else if (BigInt(n.asset) !== asset) {
            rejected.otherAsset++;
        } else if (BigInt(n.value) < rules.dust) {
            rejected.dust++;
        } else if (inCooldown(n, rules)) {
            rejected.cooldown++;
        } else {
            candidates.push(n);
        }
    }
    return { candidates, rejected };
}

/**
 * Whether a note is younger than `cooldown` blocks.
 *
 * Requires both a tip and a per-note `firstSeenBlock`; without either, every
 * note is treated as spendable.
 */
function inCooldown(n: StoredNote, rules: { cooldown: number; tip: number | undefined }): boolean {
    if (rules.cooldown <= 0 || rules.tip === undefined) return false;
    if (n.firstSeenBlock === undefined) return false;
    return rules.tip - n.firstSeenBlock < rules.cooldown;
}

/** `"8 spent, 3 below dust threshold"` — omits rules that rejected nothing. */
function describeRejections(r: RejectionCounts): string {
    const reasons: ReadonlyArray<readonly [count: number, label: string]> = [
        [r.spent, "spent"],
        [r.reserved, "awaiting an earlier spend"],
        [r.otherAsset, "other asset"],
        [r.dust, "below dust threshold"],
        [r.cooldown, "in spend cooldown"],
    ];
    const held = reasons
        .filter(([count]) => count > 0)
        .map(([count, label]) => `${count} ${label}`);
    return held.length > 0 ? held.join(", ") : "none held";
}

/**
 * Pick up to `maxInputs` unspent notes for `asset` summing to ≥ `target + fee`
 * via SFRT.
 *
 * Rationale: largest-first leaves a value-ordering fingerprint (Tramèr USENIX'24);
 * randomized tiebreak restores indistinguishability (Chen & Bonneau FC'25);
 * smallest-cover drains dust so wallet note count shrinks over time.
 *
 * For each cover size 1..`maxInputs` the smallest qualifying sum is found, the
 * smallest of those wins, and ties break toward fewer notes. The chosen size
 * is then shuffled within its bucket, so the note picked is not a
 * deterministic function of the wallet's contents.
 *
 * @internal
 */
export function selectNotes(
    all: readonly StoredNote[],
    asset: AssetId,
    target: CircuitAmount,
    opts: SelectOpts = {},
): SelectionResult {
    const fee = opts.fee ?? 0n;
    const dust = opts.dustThreshold ?? 0n;
    const cooldown = opts.cooldownBlocks ?? DEFAULT_COOLDOWN_BLOCKS;
    const tip = opts.tipBlock;
    const bucketPct = opts.bucketPct ?? 0.05;
    const maxInputs = opts.maxInputs ?? DEFAULT_SHAPE.nIn;
    const pick = opts.pick ?? randomBelow;
    const threshold = target + fee;

    const { candidates, rejected } = partitionSpendable(all, asset, {
        dust,
        cooldown,
        tip,
        now: Date.now(),
    });

    if (candidates.length === 0) {
        throw new SelectionError(
            `no spendable notes for asset ${asset} ` +
                `(${all.length} in store: ${describeRejections(rejected)})`,
            { asset },
        );
    }

    const asc = [...candidates].sort((a, b) => cmp(BigInt(a.value), BigInt(b.value)));
    const values = asc.map((n) => BigInt(n.value));

    // Smallest qualifying sum at each size; ties break toward fewer notes,
    // so a strict `<` keeps the earliest (smallest) size that achieves it.
    let bestSize = 0;
    let bestSum: bigint | null = null;
    for (let size = 1; size <= Math.min(maxInputs, values.length); size++) {
        const cover = smallestCover(values, threshold, size);
        if (cover !== null && (bestSum === null || cover < bestSum)) {
            bestSum = cover;
            bestSize = size;
        }
    }

    if (bestSum !== null) {
        const tied = coverBucket(values, threshold, bestSum, bucketPct, bestSize);
        // `coverBucket` always contains the cover that produced `bestSum`, so
        // it is never empty and `pick` is never asked for a bound of zero.
        const chosen = tied[pick(tied.length)]!;
        const notes = chosen.map((i) => asc[i]!);
        return {
            plan: "direct",
            notes,
            sum: branded<CircuitAmount>(notes.reduce((acc, n) => acc + BigInt(n.value), 0n)),
        };
    }

    const total = candidates.reduce((s, n) => s + BigInt(n.value), 0n);
    if (total >= threshold && candidates.length >= 2) {
        // Merge as many of the smallest notes as the circuit can consume, so a
        // wider shape needs fewer consolidation rounds to reach a cover.
        const consolidate = asc.slice(0, Math.min(maxInputs, asc.length));
        return {
            plan: "consolidate-first",
            consolidate,
            consolidateSum: branded<CircuitAmount>(
                consolidate.reduce((acc, n) => acc + BigInt(n.value), 0n),
            ),
            targetWithFee: branded<CircuitAmount>(threshold),
        };
    }

    throw new SelectionError(
        `insufficient unspent value for asset ${asset}: have ${total}, need ${threshold}`,
        { asset },
    );
}

/** Enumerated combinations are capped so a large wallet cannot stall a spend. */
const MAX_COMBINATIONS = 50_000;

/**
 * Smallest sum ≥ `threshold` reachable with exactly `size` of `values`, or
 * `null` if no such combination exists.
 *
 * `values` is ascending, which is what makes the search cheap: once the
 * best case for a branch — the running sum plus `size` copies of the current
 * value, the smallest anything further along can contribute — cannot beat the
 * incumbent, no later index can either, so the loop breaks rather than
 * continues.
 */
function smallestCover(values: readonly bigint[], threshold: bigint, size: number): bigint | null {
    if (size > values.length) return null;

    // Seeded with the sum of the `size` largest values — the most any
    // combination of this size can reach.
    //
    // Two things follow, and the second is the load-bearing one. If even that
    // falls short, no combination qualifies and the walk is skipped entirely.
    // Otherwise it is itself a valid cover, so the prune below has an incumbent
    // from the very first branch. Starting at `null` instead meant the prune
    // was dead until the first success — and on a wallet whose largest notes
    // cannot reach `threshold` there is no success, so every C(n, size) was
    // enumerated before returning null. That is exactly the dusty wallet that
    // needs `consolidate-first`, which is reached only after this returns.
    let best = 0n;
    for (let i = values.length - size; i < values.length; i++) best += values[i]!;
    if (best < threshold) return null;

    // The seed makes the search cheap in practice, but branch-and-bound has no
    // polynomial guarantee, so the documented cap is enforced here too. Bailing
    // early returns the incumbent, which is always a real cover — a possibly
    // non-minimal selection, never a stalled spend.
    let visited = 0;
    let truncated = false;

    const walk = (start: number, remaining: number, sum: bigint): void => {
        if (remaining === 0) {
            if (sum >= threshold && sum < best) best = sum;
            return;
        }
        for (let i = start; i + remaining <= values.length; i++) {
            if (++visited > MAX_COMBINATIONS) {
                truncated = true;
                return;
            }
            const v = values[i]!;
            const floor = sum + v * BigInt(remaining);
            // Ascending values: if this branch's best case cannot beat the
            // incumbent, no later index can either.
            if (floor >= best) break;
            walk(i + 1, remaining - 1, sum + v);
            if (truncated) return;
        }
    };

    walk(0, size, 0n);
    if (truncated) log.debug("selection cover search truncated", { size, cap: MAX_COMBINATIONS });
    return best;
}

/**
 * Every combination of exactly `size` values whose sum is ≥ `threshold` and
 * within `(1 ± bucketPct) * target` — the set the tiebreak shuffles over.
 *
 * Always contains at least the combination that produced `target`, so callers
 * can index into the result.
 */
function coverBucket(
    values: readonly bigint[],
    threshold: bigint,
    target: bigint,
    bucketPct: number,
    size: number,
): number[][] {
    const lo = mulFloat(target, 1 - bucketPct);
    const hi = mulFloat(target, 1 + bucketPct);
    const out: number[][] = [];
    const pick: number[] = [];

    const walk = (start: number, remaining: number, sum: bigint): void => {
        if (out.length >= MAX_COMBINATIONS) return;
        if (remaining === 0) {
            if (sum >= threshold && sum >= lo && sum <= hi) out.push([...pick]);
            return;
        }
        for (let i = start; i + remaining <= values.length; i++) {
            const v = values[i]!;
            // Ascending values: once the branch's floor is past `hi`, so is
            // every later index.
            if (sum + v * BigInt(remaining) > hi) break;
            pick.push(i);
            walk(i + 1, remaining - 1, sum + v);
            pick.pop();
            if (out.length >= MAX_COMBINATIONS) return;
        }
    };

    walk(0, size, 0n);
    if (out.length >= MAX_COMBINATIONS) {
        log.debug("selection bucket truncated", { size, cap: MAX_COMBINATIONS });
    }
    return out;
}

function mulFloat(v: bigint, f: number): bigint {
    const scaled = BigInt(Math.round(f * 1_000_000));
    return (v * scaled) / 1_000_000n;
}

function cmp(a: bigint, b: bigint): number {
    return a < b ? -1 : a > b ? 1 : 0;
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

/** Smallest-First with Random Tiebreak. */
export class SfrtCoinSelector implements CoinSelector {
    select(
        all: readonly StoredNote[],
        asset: AssetId,
        target: CircuitAmount,
        opts?: SelectOpts,
    ): SelectionResult {
        return selectNotes(all, asset, target, opts);
    }
}
