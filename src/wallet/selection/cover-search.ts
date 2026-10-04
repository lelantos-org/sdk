// Bounded combinatorial search over an ascending value list.
//
// Both walks prune on that ordering and both are capped, so a large wallet gets
// a non-minimal answer instead of a stalled spend.

import { getLogger } from "../../log/logger.js";

const log = getLogger("lelantos:wallet:selection");

/** Per-walk cap: nodes visited by `smallestCover`, combinations kept by `coverBucket`. */
const MAX_COMBINATIONS = 50_000;

/**
 * Smallest sum ≥ `threshold` reachable with exactly `size` of `values`, or
 * `null` if no such combination exists. When the walk hits the cap the result
 * is a valid, possibly non-minimal, cover.
 *
 * `values` is ascending, so once a branch's best case (the running sum plus
 * the current value for each remaining slot) cannot beat the incumbent, no
 * later index can either and the loop breaks.
 */
export function smallestCover(
    values: readonly bigint[],
    threshold: bigint,
    size: number,
): bigint | null {
    if (size > values.length) return null;

    // Seeded with the sum of the `size` largest values, the maximum for this
    // size. If it falls short no combination qualifies (the `consolidate-first`
    // case) and the walk is skipped instead of enumerating every C(n, size);
    // otherwise it is a valid cover that gives the prune an incumbent.
    let best = 0n;
    for (let i = values.length - size; i < values.length; i++) best += values[i]!;
    if (best < threshold) return null;

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
export function coverBucket(
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
            // Ascending: once a branch's floor passes `hi`, so does every later index.
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
