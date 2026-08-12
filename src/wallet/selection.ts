// Coin selector: SFRT — Smallest-First with Random Tiebreak.

import { type AssetId, branded, type CircuitAmount } from "../core/brand.js";
import { SelectionError } from "../core/errors.js";
import { randomFloat01 } from "../core/random.js";
import { DEFAULT_SHAPE } from "../core/shape.js";
import { getLogger } from "../log/logger.js";
import type { StoredNote } from "./note-store.js";

const log = getLogger("lelantos:wallet:selection");

export interface SelectOpts {
    /** Cover threshold becomes `target + fee`. Default 0. */
    fee?: bigint | undefined;
    /** Notes with value < dustThreshold are excluded. Recommended: `2 * marginalFee`. */
    dustThreshold?: bigint | undefined;
    /**
     * Minimum age (blocks) before spendable. Requires `tipBlock` and
     * per-note `firstSeenBlock`; otherwise no-op.
     */
    cooldownBlocks?: number | undefined;
    tipBlock?: number | undefined;
    /** Tiebreak shuffle width: notes within `(1 ± bucketPct) * pivot`. Default 0.05. */
    bucketPct?: number | undefined;
    /**
     * Most notes a single spend may consume — the circuit's `nIn`. Defaults to
     * `DEFAULT_SHAPE.nIn`; `prepareSpend` passes the configured shape's arity.
     */
    maxInputs?: number | undefined;
    /** Injectable rng for tests. Returns float in [0, 1). */
    rng?: (() => number) | undefined;
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
    const cooldown = opts.cooldownBlocks ?? 0;
    const tip = opts.tipBlock;
    const bucketPct = opts.bucketPct ?? 0.05;
    const maxInputs = opts.maxInputs ?? DEFAULT_SHAPE.nIn;
    const rng = opts.rng ?? randomFloat01;
    const threshold = target + fee;

    const candidates = all.filter((n) => {
        if (n.spent) return false;
        if (BigInt(n.asset) !== asset) return false;
        const v = BigInt(n.value);
        if (v < dust) return false;
        if (cooldown > 0 && tip !== undefined && n.firstSeenBlock !== undefined) {
            if (tip - n.firstSeenBlock < cooldown) return false;
        }
        return true;
    });

    if (candidates.length === 0) {
        throw new SelectionError(
            `no spendable notes for asset ${asset} (after dust/cooldown filter)`,
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
        // `coverBucket` always contains the cover that produced `bestSum`, and
        // `rng()` is in [0, 1), so the index is in range.
        const chosen = tied[Math.floor(rng() * tied.length)]!;
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
    let best: bigint | null = null;

    const walk = (start: number, remaining: number, sum: bigint): void => {
        if (remaining === 0) {
            if (sum >= threshold && (best === null || sum < best)) best = sum;
            return;
        }
        for (let i = start; i + remaining <= values.length; i++) {
            const v = values[i]!;
            const floor = sum + v * BigInt(remaining);
            if (best !== null && floor >= best) break;
            walk(i + 1, remaining - 1, sum + v);
        }
    };

    walk(0, size, 0n);
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
