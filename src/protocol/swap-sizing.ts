// Swap note sizing: pure arithmetic over the pool's fee and scale.
//
// Kept apart from the swap operation (`wallet/ops/swap.ts`) so a caller displaying a quote can
// import `sizeBNote` without pulling the swap executor's graph (viem, the bundle builders, the spend
// steps); `bundle-budget.mjs` checks the eager entries stay clear of the spend path. Must import
// nothing beyond `core/`, `errors/` and sibling `protocol/` arithmetic.

import { BPS_DENOMINATOR, depositTotal } from "./fees.js";
import type { YieldRate } from "./units.js";

/**
 * A yield asset's pricing: its deposit is converted at the pool's `gross / supply` rate, not at
 * `scale` alone. Omit for a plain asset.
 */
export interface YieldPricing {
    yieldEnabled?: boolean | undefined;
    /** Required when `yieldEnabled`; see `depositTotal`. */
    rate?: YieldRate | undefined;
}

/**
 * Smallest B-note value whose on-chain Permit2 pull covers `minOut`.
 *
 * The wrapper enforces a window, `minOut ≤ pulled ≤ actualOut` (`MaspPullBelowMinOut`,
 * `MaspPullExceedsActualOut`). The closed form `minOut * BPS / (scale * (BPS + feeBps))` lands
 * below `minOut` whenever the division is inexact, which reverts.
 *
 * `pulled` is principal plus the pool's fee plus the flush fee note, and the pool floors its fee,
 * so the pull advances in steps no closed form always hits. The function starts from the
 * floor-div estimate and walks to the smallest `v` that covers `minOut`. Minimality keeps the
 * result under `actualOut`; any overshoot is wrapper-side dust forwarded to the treasury.
 *
 * `relayerFee` is in circuit units of the *out* asset and is paid from the same pull, so a
 * non-zero fee reduces the B-note rather than charging the user separately.
 *
 * Exported because it is the exact amount a swap credits, needed by any caller displaying a
 * quote. `executeSwap` encodes this value as the deposit leg's `publicIn`; it is exact, not a
 * floor, since the wrapper pulls only what the B-note needs and forwards any better-than-quoted
 * fill to the treasury. The closed form above gives a wrong display value and a reverting
 * transaction.
 */
export function sizeBNote(
    minOut: bigint,
    scaleOut: bigint,
    /** The *out* asset's `depositBps` — leg 2 mints the B-note as a deposit. */
    feeBps: bigint,
    relayerFee: bigint = 0n,
    /** The *out* asset's yield pricing: a yield B-note's pull is priced in units at the rate. */
    yieldPricing: YieldPricing = {},
): bigint {
    const pullFor = depositPull(scaleOut, feeBps, relayerFee, yieldPricing);
    let v = estimateUnits(minOut, scaleOut, feeBps, yieldPricing);
    // With a relayer fee the pull may cover `minOut` at a smaller `v`; the upward walk below cannot
    // correct that.
    while (v > 0n && pullFor(v - 1n) >= minOut) v -= 1n;
    // `pullFor` is strictly increasing in `v`, so this terminates.
    while (pullFor(v) < minOut) v += 1n;
    return v;
}

/**
 * Largest refund-note value whose on-chain Permit2 pull fits in `received`, the token base units
 * leg 1's withdraw delivers to the wrapper.
 *
 * The wrapper escrows the refund with the pull bounded by `received` and forwards the remainder
 * to the treasury, so the largest fitting value maximises the refund. Zero when no value fits.
 *
 * @internal Exported for `swap.ts` and its tests.
 */
export function sizeRefundNote(
    received: bigint,
    scaleIn: bigint,
    /** The *in* asset's `depositBps` — the refund is minted as a deposit. */
    feeBps: bigint,
    relayerFee: bigint = 0n,
    /** The *in* asset's yield pricing: a yield refund note is priced in units at the rate. */
    yieldPricing: YieldPricing = {},
): bigint {
    const pullFor = depositPull(scaleIn, feeBps, relayerFee, yieldPricing);
    const principal = received - toTokensDown(relayerFee, scaleIn, yieldPricing);
    if (principal <= 0n) return 0n;
    let v = estimateUnits(principal, scaleIn, feeBps, yieldPricing);
    // The estimate ignores fee flooring and may be off by a step either way; `pullFor` is strictly
    // increasing, so both walks terminate.
    while (v > 0n && pullFor(v) > received) v -= 1n;
    while (pullFor(v + 1n) <= received) v += 1n;
    return pullFor(v) <= received ? v : 0n;
}

/**
 * Amount MASP pulls for a deposit of `v` units: principal, the pool's fee and the flush fee note,
 * as priced by {@link depositTotal} (through the yield rate for a yield asset).
 */
function depositPull(scale: bigint, depositBps: bigint, relayerFee: bigint, y: YieldPricing) {
    return (v: bigint): bigint =>
        depositTotal({
            publicIn: v,
            feeIn: relayerFee,
            depositBps,
            scale,
            yieldEnabled: y.yieldEnabled ?? false,
            rate: y.rate,
        });
}

/**
 * Units whose pull is about `tokens`, ignoring fee flooring: the walks' starting point. A yield
 * asset converts at `gross / supply` tokens per unit (`scale` and the index are folded into the
 * ratio, as `toTokenUnitsAtRate`), so the walk is a step or two rather than proportional to the
 * index.
 */
function estimateUnits(tokens: bigint, scale: bigint, feeBps: bigint, y: YieldPricing): bigint {
    const rate = pricedRate(y);
    const [num, den] = rate ? [rate.supply, rate.gross] : [1n, scale];
    return (tokens * BPS_DENOMINATOR * num) / (den * (BPS_DENOMINATOR + feeBps));
}

/** `units` in token base units, rounded down: at the rate for a yield asset. */
function toTokensDown(units: bigint, scale: bigint, y: YieldPricing): bigint {
    const rate = pricedRate(y);
    return rate ? (units * rate.gross) / rate.supply : units * scale;
}

/** The rate a yield asset converts at, when it is usable (`toTokenUnitsAtRate` falls back on `supply == 0`). */
function pricedRate(y: YieldPricing): YieldRate | undefined {
    return y.yieldEnabled && y.rate && y.rate.supply > 0n && y.rate.gross > 0n ? y.rate : undefined;
}
