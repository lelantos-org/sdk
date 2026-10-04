// Fixed withdrawal denominations (the "ladder").
//
// `publicIn` and `publicOut` are public and normalized units do not move, so a
// direct round trip publishes the same integer at both ends. Under a
// pool-managed yield index a round underlying amount divides by a moving rate,
// which makes that integer near-unique: the withdrawal matches its deposit,
// revealing the link, the holding period and the realised yield.
//
// A ladder publishes values many other users also publish. Its entries are
// fixed integers in circuit units, so a denomination's anonymity set is every
// withdrawal of that size in the pool's history. The ladder must never be
// expressed in human units and converted at runtime: `n = human * RAY /
// (scale * index)` moves with the index and reproduces the fingerprint. Human
// values in the comments below are each entry's worth at an index of RAY.
//
// Only `publicOut` is a hard requirement. Deposits and internal transfers may
// carry any value: a deposit's amount is public and attributed to the payer
// regardless, and a transfer publishes no amount.

import { InvalidArgumentError } from "../errors/config.js";
/** A ladder: fixed circuit-unit denominations, ascending, no duplicates. */
export type Ladder = readonly bigint[];

/** `{1, 2, 5} × 10^e` for `e` in `[minExp, maxExp]`: adjacent steps are 2× or 2.5×. */
function ladder(minExp: number, maxExp: number): Ladder {
    const out: bigint[] = [];
    for (let e = minExp; e <= maxExp; e++) {
        for (const m of [1n, 2n, 5n]) out.push(m * 10n ** BigInt(e));
    }
    return out;
}

/**
 * The lowest rung of the universal window is `10^FLOOR_EXP` circuit units.
 *
 * The ladder is not keyed by token. A circuit unit is `scale / 10^decimals` of a
 * token, and an operator picks `scale` for a sensible granularity, which leaves
 * circuit units roughly value-normalised across assets: USDC at scale 1 and
 * WETH at scale 1e10 share this window.
 *
 * An amount falls in exactly one decade, so unreached decades split no
 * anonymity set; rung density within a decade does, and stays `{1, 2, 5}`.
 *
 * `FLOOR_EXP` and `CAP_EXP` are pool-wide consensus values, not tunables: two
 * SDK versions in one pool split the anonymity set at every rung outside their
 * intersection. Change them only under a coordinated migration. The golden
 * list in `denominations.test.ts` pins the rungs.
 */
const FLOOR_EXP = 5;
/**
 * The top rung is `5 × 10^CAP_EXP`: 5000 WETH at scale 1e10.
 *
 * Nothing here correlates with price, so one cap cannot suit every asset. For
 * an asset worth much per circuit unit the top decades are on the ladder, and
 * `previewWithdraw().onLadder` reports `true` for them, yet few withdrawals
 * publish them, so they give little cover. A picker should not present the top
 * of the range as equivalent to a mid-ladder rung.
 *
 * A cap that tracks value must be a per-asset operator constant, never a price
 * feed: a cap that moves with price moves the ladder, producing a time-varying
 * fingerprint.
 */
const CAP_EXP = 11;

/**
 * How far the window may sit either side of one whole token, in decades.
 *
 * The only place `decimals` is consulted; for a well-scaled asset it does not
 * bind. For an 18-decimal token at `scale = 1`, one circuit unit is 1e-18 of
 * it, so the universal window describes amounts too small to withdraw and the
 * ladder follows the asset's own granularity.
 */
const ASSET_WINDOW_DECADES = { below: 3, above: 5 } as const;

/** What a wallet needs to know about an asset to place its ladder. */
export interface LadderInputs {
    /** Circuit units → token base units. From the pool's asset entry. */
    scale: bigint;
    /**
     * ERC-20 decimals, when the adapter could resolve them. When absent,
     * {@link universalLadder} returns the unclamped window.
     */
    decimals?: number | undefined;
}

/** The unclamped window, returned by identity whenever the clamp does not bind. */
const UNIVERSAL: Ladder = ladder(FLOOR_EXP, CAP_EXP);

/** `floor(log10(x))` for a positive bigint, without going through `Number`. */
function log10Floor(x: bigint): number {
    return x.toString().length - 1;
}

/**
 * Circuit units in one whole token, as an exponent.
 *
 * `decimals - floor(log10(scale))`: USDC is `6 - 0 = 6`, WETH is `18 - 10 = 8`.
 * For a `scale` that is not a power of ten the logarithm is floored, so the
 * exponent rounds up by less than one decade.
 */
function unitExp(inputs: LadderInputs): number | undefined {
    if (inputs.decimals === undefined) return undefined;
    if (inputs.scale <= 0n) return undefined;
    return inputs.decimals - log10Floor(inputs.scale);
}

/**
 * The ladder for an asset: the universal window, clamped to what the asset's
 * own granularity can express. Never empty.
 */
export function universalLadder(inputs: LadderInputs): Ladder {
    const unit = unitExp(inputs);
    if (unit === undefined) return UNIVERSAL;

    // The window the asset's own granularity allows. Both bounds are floored
    // at 0: a denomination is a circuit-unit integer, so nothing below 10^0
    // exists. An asset whose `scale` is at least `10^(decimals + 1)` has a
    // negative `unit`, and a negative bigint exponent throws.
    const assetLo = Math.max(0, unit - ASSET_WINDOW_DECADES.below);
    const assetHi = Math.max(0, unit + ASSET_WINDOW_DECADES.above);
    const lo = Math.max(FLOOR_EXP, assetLo);
    const hi = Math.min(CAP_EXP, assetHi);

    // Overlapping: the intersection.
    if (hi >= lo) return lo === FLOOR_EXP && hi === CAP_EXP ? UNIVERSAL : ladder(lo, hi);

    // Disjoint: follow the asset rather than intersecting to nothing.
    return ladder(assetLo, assetHi);
}

/**
 * Whether a wallet uses withdrawal ladders.
 *
 * ```ts
 * true   // every asset gets its ladder (the default)
 * false  // no asset gets a ladder
 * ```
 *
 * The ladder is derived from the asset, so nothing is configured per token.
 */
export type DenominationPolicy = boolean;

/**
 * The ladder `policy` gives this asset, or `[]` when it gives none, so
 * consumers can iterate without a null check.
 */
export function resolveLadder(inputs: LadderInputs, policy: DenominationPolicy = true): Ladder {
    return policy ? universalLadder(inputs) : [];
}

/** Whether `value` is exactly one of the ladder's denominations. */
export function isDenomination(value: bigint, ladder: Ladder): boolean {
    return ladder.includes(value);
}

/** The largest denomination not exceeding `amount`, if any. */
export function largestAtMost(amount: bigint, ladder: Ladder): bigint | undefined {
    let best: bigint | undefined;
    for (const d of ladder) {
        if (d <= amount) best = d;
        else break;
    }
    return best;
}

/**
 * The `limit` largest denominations not exceeding `max`, descending.
 *
 * A fallback chain: a self-spend paying a relayer fee out of the same cover may
 * not afford the largest reachable denomination and needs the next one down.
 */
export function descendingAtMost(max: bigint, ladder: Ladder, limit: number): bigint[] {
    const out: bigint[] = [];
    for (let i = ladder.length - 1; i >= 0 && out.length < limit; i--) {
        const d = ladder[i] as bigint;
        if (d <= max) out.push(d);
    }
    return out;
}

/** The denomination closest to `amount`; ties go to the smaller. */
export function nearest(amount: bigint, ladder: Ladder): bigint | undefined {
    let best: bigint | undefined;
    let bestGap: bigint | undefined;
    for (const d of ladder) {
        const gap = d > amount ? d - amount : amount - d;
        if (bestGap === undefined || gap < bestGap) {
            best = d;
            bestGap = gap;
        }
    }
    return best;
}

/** A greedy decomposition: ladder pieces, plus at most one off-ladder remainder. */
export interface Decomposition {
    /** Ladder-valued pieces, descending. */
    pieces: bigint[];
    /** Off-ladder remainder, or `0n` when the split came out exact. */
    dust: bigint;
}

/**
 * Split `amount` into at most `maxPieces` parts, as many on the ladder as fit.
 *
 * Greedy largest-first, reserving the final part for the remainder. The parts
 * always sum to `amount`: value conservation is enforced in-circuit, so a
 * remainder is placed, never rounded away.
 *
 * ```
 * decompose(4900n, USDC, 4) → pieces [2000, 2000, 500], dust 400
 * ```
 *
 * Dust is transient: an internal transfer publishes no amount, so a later
 * self-spend can re-split `400 → 200 + 200` without disclosure.
 */
export function decompose(amount: bigint, ladder: Ladder, maxPieces: number): Decomposition {
    if (maxPieces < 1) {
        throw new InvalidArgumentError(`decompose: need at least one piece, got ${maxPieces}`, {
            argument: "maxPieces",
        });
    }
    const pieces: bigint[] = [];
    let rest = amount;
    // One slot is held back for the remainder, so a greedy run cannot fill
    // every slot and leave value unplaced.
    while (pieces.length < maxPieces - 1 && rest > 0n) {
        const d = largestAtMost(rest, ladder);
        if (d === undefined) break;
        pieces.push(d);
        rest -= d;
    }
    // The held-back slot takes the remainder as a piece when it is a ladder
    // value, so an exact split reports no dust.
    if (rest > 0n && isDenomination(rest, ladder)) {
        pieces.push(rest);
        rest = 0n;
    }
    return { pieces, dust: rest };
}
