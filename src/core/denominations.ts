// Fixed withdrawal denominations — the "ladder".
//
// `publicIn` and `publicOut` are public on every deposit and withdrawal, and
// normalized units do not move, so the naive round trip publishes the *same*
// integer at both ends. Under a pool-managed yield index a round underlying
// amount divides by a continuously moving rate, which makes that integer
// near-unique: at 5% APY a 1000-USDC deposit drifts ~1.6 units per second, so
// two users collide only by depositing the identical amount in the same block.
// The withdrawal then matches its deposit exactly, revealing the link, the
// holding period and the realised yield without breaking anything
// cryptographic.
//
// The fix is to publish values many other users also publish. A ladder of
// fixed denominations does that, and because a denomination is never derived
// from a human amount it does not move when the index does — its anonymity set
// is every withdrawal of that size in the pool's whole history, with no time
// partitioning.
//
// THE LADDER IS A SET OF FIXED INTEGERS IN CIRCUIT UNITS. It must never be
// expressed in human units and converted at runtime: `n = human * RAY /
// (scale * index)` moves as the index moves, which reproduces exactly the
// fingerprint this module exists to remove. The human values in the comments
// below are what each entry is worth at an index of RAY, and are illustrative
// only — once yield accrues, `1_000_000_000` reads as ~1050 USDC rather than
// 1000, and that is correct.
//
// Only `publicOut` is a hard requirement. Deposits and internal transfers may
// carry any value: a deposit's amount is public and attributed to the payer
// regardless, and a transfer publishes no amount at all.

/** A ladder: fixed circuit-unit denominations, ascending, no duplicates. */
export type Ladder = readonly bigint[];

/**
 * `{1, 2, 5} × 10^e` for `e` in `[minExp, maxExp]`.
 *
 * The banknote ladder. Adjacent steps are 2× or 2.5×, so any amount is
 * reachable within ~20% using two or three pieces, and the shape is one users
 * already understand without being taught — which matters for a mechanism
 * whose value depends on people not routing around it.
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
 * The ladder is not keyed by token, and does not need to be. A circuit unit is
 * `scale / 10^decimals` of a token, and an operator picks `scale` to make it a
 * sensible granularity — which leaves circuit units roughly value-normalised
 * across assets, where token units are not. Measured on the two assets this
 * module used to carry a hand-tuned table for:
 *
 *     USDC  scale 1     1 circuit unit ≈ $0.000001
 *     WETH  scale 1e10  1 circuit unit ≈ $0.00003
 *
 * ~30× apart, against ~3000× for one whole token. So one window in circuit
 * units covers both, and the two curated ladders it replaces were already the
 * same window to within two decades: $10–$100k and $3–$150k.
 *
 * Spanning more decades than any one asset needs is close to free. An amount
 * falls in exactly one decade, so rungs at decades nobody reaches split no
 * anonymity set; what splits sets is rung density *within* a decade, and that
 * stays `{1, 2, 5}`. Widening is not the same kind of change as densifying.
 *
 * THESE ARE POOL-WIDE CONSENSUS VALUES, NOT TUNABLES. Under the address table
 * they replaced, editing an entry moved one token's ladder; here a one-line
 * edit reshapes every asset's ladder for every wallet on that version, and two
 * SDK versions in one pool split the anonymity set at every rung outside their
 * intersection. Change them only under a coordinated migration, the way
 * `treeDepth` is changed. The golden list in `denominations.test.ts` pins the
 * rungs literally so a change cannot land unnoticed.
 */
const FLOOR_EXP = 5;
/**
 * The top rung is `5 × 10^CAP_EXP`.
 *
 * Set by the *looser* of the two hand-tuned ladders — USDC's, which allowed
 * ~$100k — so a large withdrawal of a cheap-per-unit asset stays a single
 * transaction rather than repeating a low top rung across more pieces than
 * there are output slots.
 *
 * The cost falls on the assets worth most per circuit unit. Nothing here
 * correlates with value — WETH and a stablecoin can be byte-identical in
 * `scale` and `decimals` and 3000× apart in price — so one cap cannot be right
 * for both, and this one is the loose end of that trade: WETH tops out around
 * 5000 tokens rather than the 50 its curated ladder allowed, so a withdrawal
 * above ~50 ETH is a rarer integer than it used to be, and one above 5000 ETH
 * is the first that blends by repeating.
 *
 * Worth being precise about what the loose end costs, because it is not merely
 * generosity: the top decades *exist* and `previewWithdraw().onLadder` reports
 * `true` for them, while almost nobody publishes them. An anonymity set is
 * actual, not potential — so a rung nobody uses is worse than an absent one,
 * because the wallet believes it is conforming and tells the user so. A picker
 * should not present the top of the range as equivalent to a mid-ladder rung.
 *
 * To make the cap track value rather than granularity, it has to come from
 * whoever knows what the asset is worth: a per-asset cap published by the pool
 * operator alongside `scale` and `decimals`, falling back to this window when
 * absent. That keeps the derivation automatic and adds no table here. It must
 * be an operator constant and never a price feed — a cap that moves with price
 * moves the ladder with it, which is the time-varying fingerprint this module
 * exists to remove.
 */
const CAP_EXP = 11;

/**
 * How far the window may sit either side of one whole token, in decades.
 *
 * The only place `decimals` is consulted, and for a sanely scaled asset it does
 * not bind at all — see {@link FLOOR_EXP}. It exists for the asset that is not:
 * register an 18-decimal token at `scale = 1` and one circuit unit is 1e-18 of
 * it, so the universal window describes amounts far too small to withdraw and a
 * single token would need millions of pieces. Anchoring to the asset's own
 * granularity turns that into a bounded ladder.
 */
const ASSET_WINDOW_DECADES = { below: 3, above: 5 } as const;

/** What a wallet needs to know about an asset to place its ladder. */
export interface LadderInputs {
    /** Circuit units → token base units. From the pool's asset entry. */
    scale: bigint;
    /**
     * ERC-20 decimals, when the adapter could resolve them. Absent narrows
     * nothing — see {@link ASSET_WINDOW_DECADES}.
     */
    decimals?: number | undefined;
}

/**
 * The unclamped window, built once.
 *
 * Returned by identity for every asset the clamp does not bind on, which is
 * every sanely scaled one — so the common path allocates nothing and every such
 * asset shares one array.
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
 * `scale` that is not a power of ten floors, which is the conservative
 * direction — it can only place the window lower, never higher than the asset
 * can represent.
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
 * Every asset gets one, and it is never empty. There is no table to be absent
 * from and nothing for a caller to supply, which removes the failure this
 * module used to warn about — an unlisted token silently resolving to no
 * ladder, reverting to even splits with nothing anywhere saying why.
 */
export function universalLadder(inputs: LadderInputs): Ladder {
    const unit = unitExp(inputs);
    if (unit === undefined) return UNIVERSAL;

    // What the asset's own granularity says the window should be.
    //
    // Floored at 0 in both bounds: a denomination is a circuit-unit integer, so
    // there is nothing below 10^0 to offer. An asset whose `scale` exceeds
    // `10^decimals` — one circuit unit worth many whole tokens — has a negative
    // `unit`, and without this floor the exponent reaches `10n ** -23n`, which
    // throws rather than degrading.
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
 * false  // none; pre-denomination behaviour everywhere
 * ```
 *
 * A boolean rather than a table: the ladder is derived from the asset, so
 * there is nothing per-token to configure and no way to be missing from a list.
 * Opting out stays a legitimate choice — but it is now the only reason an asset
 * has no ladder, rather than one of two.
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
 * Exists for callers that need a *fallback chain* rather than a single answer:
 * a self-spend paying a relayer fee out of the same cover often cannot afford
 * the largest denomination it could otherwise reach, and needs the next one
 * down without re-deriving the list.
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
 * Dust is transient rather than permanent: an internal transfer publishes no
 * amount, so a later self-spend can re-split `400 → 200 + 200` for free. That
 * is what makes a bounded number of output slots workable against a discrete
 * ladder.
 */
export function decompose(amount: bigint, ladder: Ladder, maxPieces: number): Decomposition {
    if (maxPieces < 1) throw new RangeError(`decompose: need at least one piece, got ${maxPieces}`);
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
    // The held-back slot takes a ladder value when the remainder happens to be
    // one, so an exact split is not downgraded to dust by the reservation.
    if (rest > 0n && isDenomination(rest, ladder)) {
        pieces.push(rest);
        rest = 0n;
    }
    return { pieces, dust: rest };
}
