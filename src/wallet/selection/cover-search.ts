// Bounded combinatorial search over an ASCENDING value list.
//
// Both walks prune on that ordering — a branch whose best case cannot beat the
// incumbent ends the loop rather than the iteration — and both are capped, so a
// large wallet degrades to a non-minimal answer instead of a stalled spend.

import { getLogger } from "../../log/logger.js";

const log = getLogger("lelantos:wallet:selection");

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
export function smallestCover(
    values: readonly bigint[],
    threshold: bigint,
    size: number,
): bigint | null {
    if (size > values.length) return null;

    // Seeded with the sum of the `size` largest values — the most any
    // combination of this size can reach.
    //
    // Two things follow. If even that sum falls short, no combination
    // qualifies and the walk is skipped entirely. Otherwise it is itself a
    // valid cover, giving the prune below an incumbent from the first branch.
    // Seeding with `null` would leave the prune inert until the first success,
    // and a wallet whose largest notes cannot reach `threshold` has none — so
    // every C(n, size) would be enumerated before returning null. That is the
    // dusty wallet needing `consolidate-first`, reached only after this
    // returns.
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
