// SFRT — Smallest-First with Random Tiebreak, the default coin selector.

import { type AssetId, branded, type CircuitAmount } from "../../core/brand.js";
import { cmpBigint } from "../../core/compare.js";
import { randomBelow } from "../../core/random.js";
import { DEFAULT_SHAPE } from "../../protocol/shape.js";
import type { StoredNote } from "../notes/note-store.js";
import { coverBucket, smallestCover } from "./cover-search.js";
import { fundingError, partitionSpendable, spendRules } from "./spendability.js";
import type { CoinSelector, SelectionResult, SelectOpts } from "./types.js";

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
 * is then shuffled within its bucket, so the selection is not a deterministic
 * function of the wallet's contents.
 *
 * @internal
 */
export function selectNotes(
    all: readonly StoredNote[],
    asset: AssetId,
    target: CircuitAmount,
    opts: SelectOpts = {},
): SelectionResult {
    const bucketPct = opts.bucketPct ?? 0.05;
    const maxInputs = opts.maxInputs ?? DEFAULT_SHAPE.nIn;
    const pick = opts.pick ?? randomBelow;
    const threshold = target + (opts.fee ?? 0n);

    const rules = spendRules(opts);
    const { candidates } = partitionSpendable(all, asset, rules);

    if (candidates.length === 0) throw fundingError(all, asset, threshold, rules);

    const asc = [...candidates].sort((a, b) => cmpBigint(BigInt(a.value), BigInt(b.value)));
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
        // `pick` is never called with a bound of zero.
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

    // Below the threshold in total: either nothing more exists, or it is held back.
    throw fundingError(all, asset, threshold, rules);
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
