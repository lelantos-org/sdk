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
 * `{1, 2, 5} × 10^e` for `e` in `[minExp, maxExp]`, capped at `max`.
 *
 * The banknote ladder. Adjacent steps are 2× or 2.5×, so any amount is
 * reachable within ~20% using two or three pieces, and the shape is one users
 * already understand without being taught — which matters for a mechanism
 * whose value depends on people not routing around it.
 */
function ladder(minExp: number, maxExp: number, max?: bigint): Ladder {
    const out: bigint[] = [];
    for (let e = minExp; e <= maxExp; e++) {
        for (const m of [1n, 2n, 5n]) {
            const v = m * 10n ** BigInt(e);
            if (max === undefined || v <= max) out.push(v);
        }
    }
    return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * USDC, `scale = 1` on every deployed chain, so one circuit unit is 1e-6 USDC.
 * $10 … $100k at an index of RAY.
 *
 * The top is capped deliberately. A $500k withdrawal as a unique 500k
 * denomination has an anonymity set of one; as five 100k pieces each blends
 * with every other 100k note in the pool. Truncating the ladder helps large
 * holders rather than restricting them.
 */
const USDC_LADDER = ladder(7, 11, 100_000_000_000n);

/**
 * WETH, `scale = 1e10`, so one circuit unit is 1e-8 WETH (10 gwei).
 * 0.001 … 50 WETH at an index of RAY.
 *
 * The floor is 0.001 rather than 0.01 because dust is bounded by the lowest
 * denomination: at 0.01 a decomposition would discard up to ~$30 of every
 * deposit at $3k/ETH. The three extra entries sit at the thin end of the
 * ladder, where set concentration barely matters.
 */
const WETH_LADDER = ladder(5, 9);

/**
 * Ladders by ERC-20 address, lowercased.
 *
 * Keyed by **address**, never by symbol. A mis-resolved ladder silently splits
 * the anonymity set — the one failure mode that cannot be detected from inside
 * the wallet — and symbol sniffing is exactly how that happens. (`chains.ts`
 * carries an `isWeth` symbol check already flagged in-repo as the shape not to
 * copy.)
 *
 * An asset absent from this table has no ladder, and every path below degrades
 * to its pre-denomination behaviour rather than inventing one.
 */
const LADDERS: ReadonlyMap<string, Ladder> = new Map([
    // USDC
    ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", USDC_LADDER], // mainnet
    ["0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", USDC_LADDER], // base
    ["0xaf88d065e77c8cc2239327c5edb3a432268e5831", USDC_LADDER], // arbitrum
    // WETH
    ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", WETH_LADDER], // mainnet
    ["0x4200000000000000000000000000000000000006", WETH_LADDER], // base
    ["0x82af49447d8a07e3bd95bd0d56f35241523fbab1", WETH_LADDER], // arbitrum
]);

/** The built-in ladder for an ERC-20, or `undefined` when there is none. */
export function ladderFor(token: string): Ladder | undefined {
    return LADDERS.get(token.toLowerCase());
}

/**
 * Which ladders a wallet uses.
 *
 * ```ts
 * true                      // built-in ladders (the default)
 * false                     // none; pre-denomination behaviour everywhere
 * new Map([[token, [...]]]) // custom ladders, replacing the built-ins entirely
 * ```
 *
 * Opting out is a legitimate choice, not a footgun to be discouraged. The
 * built-in table only covers USDC and WETH on three chains, so an integrator
 * elsewhere has no ladder to conform to — and a wallet reshaping change onto a
 * ladder nobody else uses is as distinguishable as one ignoring a ladder
 * everyone else follows. What costs privacy is being in a small group, in
 * either direction.
 *
 * A custom map **replaces** the built-ins rather than extending them, so a
 * caller supplying one gets exactly the ladders it listed and no surprises
 * from a table it did not write. Spread `BUILT_IN_LADDERS` to extend instead.
 *
 * Keys are ERC-20 addresses, matched case-insensitively: a checksummed address
 * and its lowercase form resolve to the same ladder.
 */
export type DenominationPolicy = boolean | ReadonlyMap<string, Ladder>;

/** The built-in table, for callers extending rather than replacing it. */
export const BUILT_IN_LADDERS: ReadonlyMap<string, Ladder> = LADDERS;

/**
 * The ladder `policy` gives this token, or `[]` when it gives none.
 *
 * Empty rather than `undefined` so consumers can iterate without a null check;
 * `hasLadder` is `length > 0`.
 */
/**
 * Case-normalised copies of caller-supplied tables, keyed by the original.
 *
 * The built-in table is lowercased at the source, but a caller's is whatever
 * they had to hand — and an EIP-55 checksummed address is what every wallet,
 * explorer and deploy script hands you. Matching it verbatim against a
 * lowercased lookup misses, and the miss is silent: the asset simply reports no
 * ladder, change goes back to splitting evenly, and nothing anywhere says why.
 * That is precisely the undetectable-from-inside failure this module exists to
 * avoid, so casing is normalised rather than documented.
 *
 * Weakly keyed and built once per table: `resolveLadder` runs per asset
 * resolution, and rebuilding the map each time would be work proportional to
 * the ladder table on a path that answers from a cache.
 */
const normalised = new WeakMap<ReadonlyMap<string, Ladder>, ReadonlyMap<string, Ladder>>();

function lowerKeyed(table: ReadonlyMap<string, Ladder>): ReadonlyMap<string, Ladder> {
    let found = normalised.get(table);
    if (!found) {
        found = new Map([...table].map(([k, v]) => [k.toLowerCase(), v]));
        normalised.set(table, found);
    }
    return found;
}

export function resolveLadder(token: string, policy: DenominationPolicy = true): Ladder {
    if (policy === false) return [];
    const table = policy === true ? LADDERS : lowerKeyed(policy);
    return table.get(token.toLowerCase()) ?? [];
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
