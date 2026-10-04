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
 * Exact covers collected before the search stops, so a wallet with many
 * identical notes does not enumerate every equivalent subset.
 */
const MAX_EXACT_COVERS = 64;

/**
 * Nodes the search may visit per cover size before giving up.
 *
 * {@link MAX_EXACT_COVERS} does not bound the expensive case: an unreachable
 * target collects no covers and would walk every `C(n, size)`. Exhausting the
 * budget is not an error; the caller falls back to SFRT.
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
 * A cover summing to exactly `target` (zero change), or `undefined` when none
 * was found.
 *
 * Smallest cover size first, then a uniform pick among covers of that size:
 * always taking the same cover would make selection deterministic, which
 * SFRT's tiebreak exists to prevent.
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
            // Wider sizes search a strictly larger space and would exhaust too.
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
