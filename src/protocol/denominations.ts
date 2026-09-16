// Fixed withdrawal denominations — the "ladder".
//
// `publicIn` and `publicOut` are public on every deposit and withdrawal, and
// normalized units do not move, so a direct round trip publishes the *same*
// integer at both ends. Under a pool-managed yield index a round underlying
// amount divides by a continuously moving rate, which makes that integer
// near-unique: at 5% APY a 1000-USDC deposit drifts ~1.6 units per second, so
// two users collide only by depositing the identical amount in the same block.
// The withdrawal then matches its deposit exactly, revealing the link, the
// holding period and the realised yield without breaking any cryptography.
//
// A ladder of fixed denominations publishes values many other users also
// publish. A denomination is never derived from a human amount, so it does not
// move with the index: its anonymity set is every withdrawal of that size in
// the pool's history, with no time partitioning.
//
// THE LADDER IS A SET OF FIXED INTEGERS IN CIRCUIT UNITS. It must never be
// expressed in human units and converted at runtime: `n = human * RAY /
// (scale * index)` moves with the index, reproducing the fingerprint this
// module removes. Human values in the comments below are each entry's worth at
// an index of RAY and are illustrative only; once yield accrues,
// `1_000_000_000` correctly reads as ~1050 USDC rather than 1000.
//
// Only `publicOut` is a hard requirement. Deposits and internal transfers may
// carry any value: a deposit's amount is public and attributed to the payer
// regardless, and a transfer publishes no amount at all.

import { InvalidArgumentError } from "../errors/config.js";
/** A ladder: fixed circuit-unit denominations, ascending, no duplicates. */
export type Ladder = readonly bigint[];

/**
 * `{1, 2, 5} × 10^e` for `e` in `[minExp, maxExp]`.
 *
 * The banknote ladder. Adjacent steps are 2× or 2.5×, so any amount is
 * reachable within ~20% using two or three pieces, and the shape is familiar to
 * users, which matters for a mechanism that depends on people not routing
 * around it.
 */
function ladder(minExp: number, maxExp: number): Ladder {
    const out: bigint[] = [];
    for (let e = minExp; e <= maxExp; e++) {
        for (const m of [1n, 2n, 5n]) out.push(m * 10n ** BigInt(e));
    }
    return out;
}

/**
 * Where the universal window sits, as circuit-unit exponents.
 *
 * The ladder is not keyed by token. A circuit unit is `scale / 10^decimals` of a
 * token, and an operator picks `scale` for a sensible granularity, which leaves
 * circuit units roughly value-normalised across assets where token units are
 * not. For example:
 *
 *     USDC  scale 1     1 circuit unit ≈ $0.000001
 *     WETH  scale 1e10  1 circuit unit ≈ $0.00003
 *
 * ~30× apart, against ~3000× for one whole token, so one window in circuit
 * units covers both.
 *
 * Spanning more decades than any one asset needs costs little. An amount falls
 * in exactly one decade, so unreached decades split no anonymity set; what
 * splits sets is rung density *within* a decade, which stays `{1, 2, 5}`.
 *
 * THESE ARE POOL-WIDE CONSENSUS VALUES, NOT TUNABLES. A one-line edit reshapes
 * every asset's ladder for every wallet on that version, and two SDK versions
 * in one pool split the anonymity set at every rung outside their intersection.
 * Change them only under a coordinated migration, as with `treeDepth`. The
 * golden list in `denominations.test.ts` pins the rungs literally.
 */
const FLOOR_EXP = 5;
/**
 * The top rung is `5 × 10^CAP_EXP`.
 *
 * Sized for ~$100k of USDC, so a large withdrawal of a cheap-per-unit asset
 * stays a single transaction rather than repeating a low top rung across more
 * pieces than there are output slots.
 *
 * The cost falls on assets worth most per circuit unit. Nothing here correlates
 * with value (WETH and a stablecoin can share `scale` and `decimals` yet be
 * 3000× apart in price), so one cap cannot suit both: WETH tops out around 5000
 * tokens, a withdrawal above ~50 ETH is a rare integer, and one above 5000 ETH
 * is the first that blends by repeating.
 *
 * The top decades *exist* and `previewWithdraw().onLadder` reports `true` for
 * them, yet almost nobody publishes them. An anonymity set is actual, not
 * potential, so an unused rung is more harmful than an absent one: the wallet
 * reports conformance that provides no cover. A picker should not present the
 * top of the range as equivalent to a mid-ladder rung.
 *
 * A cap that tracks value must come from whoever knows the asset's worth: a
 * per-asset cap published by the pool operator alongside `scale` and
 * `decimals`, falling back to this window when absent. It must be an operator
 * constant, never a price feed: a cap that moves with price moves the ladder,
 * producing the time-varying fingerprint this module removes.
 */
const CAP_EXP = 11;

/**
 * How far the window may sit either side of one whole token, in decades.
 *
 * The only place `decimals` is consulted; for a well-scaled asset it does not
 * bind (see {@link FLOOR_EXP}). For an 18-decimal token at `scale = 1`, one
 * circuit unit is 1e-18 of it, so the universal window describes amounts far
 * too small to withdraw and a single token would need millions of pieces.
 * Anchoring to the asset's own granularity yields a bounded ladder.
 */
const ASSET_WINDOW_DECADES = { below: 3, above: 5 } as const;

/** What a wallet needs to know about an asset to place its ladder. */
export interface LadderInputs {
    /** Circuit units → token base units. From the pool's asset entry. */
    scale: bigint;
    /**
     * ERC-20 decimals, when the adapter could resolve them. Absent narrows
     * nothing — see {@link universalLadder}, which places the window.
     */
    decimals?: number | undefined;
}

/**
 * The unclamped window, built once.
 *
 * Returned by identity for every asset the clamp does not bind on (every
 * well-scaled one), so the common path allocates nothing.
 */
const UNIVERSAL: Ladder = ladder(FLOOR_EXP, CAP_EXP);

/** `floor(log10(x))` for a positive bigint, without going through `Number`. */
function log10Floor(x: bigint): number {
    return x.toString().length - 1;
}

/**
 * Circuit units in one whole token, as an exponent.
 *
 * `decimals - log10(scale)`: USDC is `6 - 0 = 6`, WETH is `18 - 10 = 8`. A
 * `scale` that is not a power of ten floors, the conservative direction: it can
 * only place the window lower, never higher than the asset can represent.
 */
function unitExp(inputs: LadderInputs): number | undefined {
    if (inputs.decimals === undefined) return undefined;
    if (inputs.scale <= 0n) return undefined;
    return inputs.decimals - log10Floor(inputs.scale);
}

/**
 * The ladder for an asset: the universal window, clamped to what the asset's
 * own granularity can sensibly express.
 *
 * Every asset gets one, it is never empty, and the caller supplies nothing
 * beyond the asset's metadata.
 */
export function universalLadder(inputs: LadderInputs): Ladder {
    const unit = unitExp(inputs);
    if (unit === undefined) return UNIVERSAL;

    // What the asset's own granularity says the window should be.
    //
    // Floored at 0 in both bounds: a denomination is a circuit-unit integer, so
    // nothing below 10^0 exists. An asset whose `scale` exceeds `10^decimals`
    // (one circuit unit worth many whole tokens) has a negative `unit`, and a
    // negative exponent such as `10n ** -23n` throws.
    const assetLo = Math.max(0, unit - ASSET_WINDOW_DECADES.below);
    const assetHi = Math.max(0, unit + ASSET_WINDOW_DECADES.above);
    const lo = Math.max(FLOOR_EXP, assetLo);
    const hi = Math.min(CAP_EXP, assetHi);

    // Normally they overlap and the intersection is the answer.
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
 * A boolean rather than a table: the ladder is derived from the asset, so there
 * is nothing per-token to configure. Opting out is the only way an asset has no
 * ladder.
 */
export type DenominationPolicy = boolean;

/**
 * The ladder `policy` gives this asset, or `[]` when it gives none.
 *
 * Empty rather than `undefined` so consumers can iterate without a null check;
 * `hasLadder` is `length > 0`.
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
 * For callers that need a *fallback chain* rather than a single answer: a
 * self-spend paying a relayer fee out of the same cover often cannot afford the
 * largest reachable denomination and needs the next one down.
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
 * Greedy largest-first, reserving the final part for whatever is left over.
 * The parts always sum to `amount` exactly — value conservation is enforced
 * in-circuit, so a remainder can never be rounded away, only placed.
 *
 * ```
 * decompose(4900n, USDC, 4) → pieces [2000, 2000, 500], dust 400
 * ```
 *
 * Dust is transient: an internal transfer publishes no amount, so a later
 * self-spend can re-split `400 → 200 + 200` without disclosure. This makes a
 * bounded number of output slots workable against a discrete ladder.
 */
export function decompose(amount: bigint, ladder: Ladder, maxPieces: number): Decomposition {
    if (maxPieces < 1) {
        throw new InvalidArgumentError(`decompose: need at least one piece, got ${maxPieces}`, {
            argument: "maxPieces",
        });
    }
    const pieces: bigint[] = [];
    let rest = amount;
    // One slot is held back for the remainder; without it a greedy run that
    // uses every slot would have nowhere to put what it could not place.
    while (pieces.length < maxPieces - 1 && rest > 0n) {
        const d = largestAtMost(rest, ladder);
        if (d === undefined) break;
        pieces.push(d);
        rest -= d;
    }
    // The held-back slot takes the remainder as a piece when it is a ladder
    // value, so an exact split is not downgraded to dust.
    if (rest > 0n && isDenomination(rest, ladder)) {
        pieces.push(rest);
        rest = 0n;
    }
    return { pieces, dust: rest };
}
