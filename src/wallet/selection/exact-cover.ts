// Zero-change cover search: subsets that pay the target exactly.
//
// Optional: every caller falls back to SFRT when no exact cover is found.

import type { AssetId, CircuitAmount } from "../../core/brand.js";
import { cmpBigint } from "../../core/compare.js";
import { randomBelow } from "../../core/random.js";
import { getLogger } from "../../log/logger.js";
import { DEFAULT_SHAPE } from "../../protocol/shape.js";
import type { StoredNote } from "../notes/note-store.js";
import { partitionSpendable, spendRules } from "./spendability.js";
import type { DirectSelection, SelectOpts } from "./types.js";

const log = getLogger("lelantos:wallet:selection");

/**
 * Exact covers collected before the search stops.
 *
 * Caps found covers so a wallet with many identical notes does not enumerate
 * every equivalent subset.
 */
const MAX_EXACT_COVERS = 64;

/**
 * Nodes the exact-cover search may visit before abandoning the attempt.
 *
 * Separate from {@link MAX_EXACT_COVERS} because the expensive case finds
 * nothing: an unreachable target never increments the found counter, and
 * `C(n, 4)` over a few hundred notes is too slow for a spend path. Exhausting
 * the budget is not an error; the caller falls back to SFRT.
 */
const MAX_EXACT_NODES = 20_000;

/** An exact-cover search result, and whether the budget cut it short. */
interface ExactSearch {
    /** Index lists into the ascending value array, each summing to the target. */
    covers: number[][];
    /** True when {@link MAX_EXACT_NODES} ran out before the space was covered. */
    exhausted: boolean;
}

/**
 * Subsets of `values` of size `size` summing to exactly `target`.
 *
 * Depth-first over an ascending list with two cuts: stop descending once a
 * value overshoots what is left, and stop widening once too few values remain
 * to fill the subset. Both are sound only because `values` is ascending.
 */
function exactSubsets(values: readonly bigint[], target: bigint, size: number): ExactSearch {
    const covers: number[][] = [];
    const chosen: number[] = [];
    let budget = MAX_EXACT_NODES;

    const walk = (from: number, depth: number, left: bigint): void => {
        if (depth === 0) {
            if (left === 0n) covers.push([...chosen]);
            return;
        }
        for (let i = from; i <= values.length - depth; i++) {
            if (covers.length >= MAX_EXACT_COVERS || budget <= 0) return;
            budget--;
            const value = values[i] as bigint;
            // Ascending, so once one value overshoots so does every later one.
            if (value > left) return;
            chosen.push(i);
            walk(i + 1, depth - 1, left - value);
            chosen.pop();
        }
    };

    walk(0, size, target);
    return { covers, exhausted: budget <= 0 };
}

/**
 * A cover summing to exactly `target`, or `undefined` when none was found.
 *
 * Exact means zero change. Change can land off the withdrawal ladder and need
 * re-splitting before withdrawal, so a spend with none avoids that.
 *
 * Smallest cover size first, then a uniform pick among covers of that size.
 * Always taking the same exact cover would make selection deterministic given
 * a public note set, which SFRT's tiebreak is designed to prevent.
 */
export function exactCover(
    all: readonly StoredNote[],
    asset: AssetId,
    target: CircuitAmount,
    opts: SelectOpts,
): DirectSelection | undefined {
    const maxInputs = Math.max(0, opts.maxInputs ?? DEFAULT_SHAPE.nIn);
    if (target <= 0n || maxInputs === 0) return undefined;

    const { candidates } = partitionSpendable(all, asset, spendRules(opts));
    const ascending = [...candidates].sort((a, b) => cmpBigint(BigInt(a.value), BigInt(b.value)));
    const values = ascending.map((n) => BigInt(n.value));
    const pick = opts.pick ?? randomBelow;

    for (let size = 1; size <= maxInputs; size++) {
        const { covers, exhausted } = exactSubsets(values, target, size);
        if (covers.length > 0) {
            const chosen = covers[pick(covers.length)] ?? (covers[0] as number[]);
            return {
                plan: "direct",
                notes: chosen.map((i) => ascending[i] as StoredNote),
                sum: target,
            };
        }
        if (exhausted) {
            // Wider sizes search a strictly larger space and would exhaust too,
            // so fall back to SFRT immediately.
            log.debug("exact-cover search hit its node budget; falling back", {
                asset: asset.toString(),
                target: target.toString(),
                size,
            });
            return undefined;
        }
    }
    return undefined;
}
