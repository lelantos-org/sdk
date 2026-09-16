// Fee arithmetic and the on-chain amount bounds it has to respect.

import { branded, type CircuitAmount, type TokenAmount } from "../core/brand.js";
import { InvalidArgumentError } from "../errors/config.js";
import { RAY, toTokenUnitsAtRate, type YieldRate } from "./units.js";

/**
 * Basis-points denominator. `feeBps` is a uint16 fraction of 10_000;
 * `fee = amount * feeBps / BPS_DENOMINATOR` mirrors `MASP._takeFee`
 * on-chain.
 */
export const BPS_DENOMINATOR = 10_000n;

/**
 * Mirrors the `MASP.PublicInTooLarge` bound: `d.publicIn > type(uint48).max`
 * reverts on-chain. The SDK pre-checks against this to surface an actionable
 * error instead of a relayer 500.
 */
export const PUBLIC_IN_MAX = (1n << 48n) - 1n;

/** Fee on `amount` at `feeBps`, truncated — matches Solidity integer division. */
export function applyFee(amount: bigint, feeBps: bigint): bigint {
    return (amount * feeBps) / BPS_DENOMINATOR;
}

/**
 * Fee on a count of normalized units, rounded **up** — mirrors `Fees.unitFee`.
 *
 * The plain path ({@link applyFee}) multiplies `scale` in before dividing, so it
 * floors at base-unit granularity. A yield asset charges its fee in units, so
 * the escrow digest stays index-free; since one unit is worth `scale` base
 * units, flooring would discard up to a whole `scale` per operation and charge
 * nothing below `BPS_DENOMINATOR / feeBps` units (under 400 at 25 bps). The pool
 * rounds up, so every yield-branch quote must too: a quote one unit low produces
 * a Permit2 pull the pool refuses.
 */
export function unitFee(units: bigint, feeBps: bigint): bigint {
    const num = units * feeBps;
    if (num === 0n) return 0n;
    return (num - 1n) / BPS_DENOMINATOR + 1n;
}

/** An asset's two protocol fee rates, in basis points. */
export interface FeeRates {
    /** Charged **on top of** the principal on a shield. */
    depositBps: bigint;
    /** **Skimmed from** the proceeds on an unshield. */
    withdrawBps: bigint;
}

/**
 * A caller-supplied replacement for what the pool reports.
 *
 * A bare `bigint` sets both legs (typical for a test pool or fixture). Pass the
 * pair to price the legs separately.
 */
export type FeeOverride = bigint | FeeRates;

/** {@link FeeOverride} applied to what the chain reported, or that unchanged. */
export function resolveFeeRates(reported: FeeRates, override?: FeeOverride | undefined): FeeRates {
    if (override === undefined) return reported;
    if (typeof override === "bigint") return { depositBps: override, withdrawBps: override };
    return override;
}

/**
 * Guard a value destined for `DepositRequest.publicIn` against the uint48
 * bound the pool enforces.
 *
 * @throws {InvalidArgumentError} naming the asset and the representable max.
 */
export function assertPublicInFits(
    value: bigint,
    ctx: { what: string; asset?: bigint; scale?: bigint },
): void {
    if (value <= PUBLIC_IN_MAX) return;
    const asset = ctx.asset !== undefined ? ` for asset ${ctx.asset}` : "";
    const hint =
        ctx.scale !== undefined
            ? ` (max ${PUBLIC_IN_MAX * ctx.scale} token base units at scale ${ctx.scale})`
            : "";
    throw new InvalidArgumentError(
        `${ctx.what} is ${value} circuit units${asset}, above the on-chain ` +
            `uint48 limit of ${PUBLIC_IN_MAX}${hint}`,
        { argument: ctx.what },
    );
}

/** What a withdrawal of `publicOut` costs and delivers. See {@link withdrawNet}. */
export interface WithdrawNetArgs {
    /** The gross leaving the pool — a ladder denomination, in circuit units. */
    publicOut: bigint;
    /** The asset's withdraw rate. */
    feeBps: bigint;
    /** circuit-units → ERC-20-base-units multiplier. */
    scale: bigint;
    /** Pool-managed yield index, RAY-scaled. Defaults to `RAY`. */
    index?: bigint;
    /** Whether the pool routes this asset to a yield venue. Defaults to `false`. */
    yieldEnabled?: boolean;
}

/** The two halves of a withdrawal, in ERC-20 base units. */
export interface WithdrawNet {
    /** Reaches the recipient. */
    net: bigint;
    /** Accrues to the treasury. */
    fee: bigint;
}

/**
 * Split a withdrawal's gross into what the recipient receives and what the
 * protocol keeps.
 *
 * `publicOut` is the **gross**: `MASP._unshieldLeg` skims the fee out of the
 * amount leaving the pool (`net = outAmt - fee`) rather than charging it on
 * top. A caller picks the gross (a ladder denomination, since that figure is
 * published on chain) and receives slightly less.
 *
 * The two branches mirror the contract exactly and are **not**
 * interchangeable: they round at different points, so the wrong one misreports
 * the net by up to a unit.
 *
 *   plain  the fee is taken from the converted token amount, floored
 *   yield  the fee is taken in normalized units *before* conversion and
 *          rounded up (`YieldOps._unshield` → `Fees.unitFee`), which is what
 *          keeps `_drainDeposit` index-free and the escrow digest stable
 */
export function withdrawNet(args: WithdrawNetArgs): WithdrawNet {
    const { publicOut, feeBps, scale, index = RAY, yieldEnabled = false } = args;
    const toTokens = (units: bigint): bigint => (units * scale * index) / RAY;

    if (yieldEnabled) {
        const feeNorm = unitFee(publicOut, feeBps);
        const net = toTokens(publicOut - feeNorm);
        return { net, fee: toTokens(publicOut) - net };
    }
    const gross = toTokens(publicOut);
    const fee = applyFee(gross, feeBps);
    return { net: gross - fee, fee };
}

/** Inputs of {@link grossForNet}: {@link WithdrawNetArgs} with the target net in place of the gross. */
export interface GrossForNetArgs extends Omit<WithdrawNetArgs, "publicOut"> {
    /** Base units the recipient must receive at least. */
    net: bigint;
}

/**
 * The smallest `publicOut` (circuit units) whose {@link withdrawNet} delivers at least `net` base
 * units.
 *
 * Inverts `withdrawNet` on both of its branches, so the yield branch's unit-denominated, rounded-up
 * fee is accounted for exactly. `withdrawNet(publicOut).net` is non-decreasing in `publicOut` on
 * both branches, so the minimum is found by bisection over a bound that is checked, never assumed.
 *
 * The result is rarely a denomination: publishing it makes the withdrawal distinguishable.
 * Returns `0n` for a `net` of zero or less.
 *
 * @throws {InvalidArgumentError} when no `publicOut` can deliver `net` (a fee of 100% or more, or a
 * zero `scale` / `index`).
 */
export function grossForNet(args: GrossForNetArgs): bigint {
    const { net: target, feeBps, scale, index = RAY, yieldEnabled = false } = args;
    if (target <= 0n) return 0n;
    if (feeBps >= BPS_DENOMINATOR || feeBps < 0n || scale <= 0n || index <= 0n) {
        throw new InvalidArgumentError(
            `no withdrawal delivers ${target} base units at ${feeBps} bps ` +
                `(scale ${scale}, index ${index})`,
            { argument: "net" },
        );
    }
    const netOf = (publicOut: bigint): bigint =>
        withdrawNet({ publicOut, feeBps, scale, index, yieldEnabled }).net;

    // Estimate from the continuous inverse, then widen until it provably covers the target.
    let hi = (target * RAY * BPS_DENOMINATOR) / (scale * index * (BPS_DENOMINATOR - feeBps)) + 2n;
    while (netOf(hi) < target) hi *= 2n;
    // Invariant: netOf(lo) < target <= netOf(hi); netOf(0) is 0 on both branches.
    let lo = 0n;
    while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n;
        if (netOf(mid) >= target) hi = mid;
        else lo = mid;
    }
    return hi;
}

/** What a shield charges the payer, and the pieces it is made of. */
export interface DepositTotalArgs {
    /** Principal, in circuit units. */
    publicIn: bigint;
    /** Value of the relayer's fee note, in circuit units. */
    feeIn: bigint;
    /** The asset's deposit rate. */
    depositBps: bigint;
    /** circuit-units → ERC-20-base-units multiplier. */
    scale: bigint;
    /** Whether the pool routes this asset to a yield venue. Defaults to `false`. */
    yieldEnabled?: boolean;
    /** Required when `yieldEnabled`; see {@link YieldRate}. */
    rate?: YieldRate | undefined;
}

/**
 * What the pool will pull from the payer for one shield, in ERC-20 base units.
 *
 * Counterpart to {@link withdrawNet}, branching for the same reason: a shield is
 * charged **on top of** the principal while a withdrawal is skimmed out of it,
 * and the two unit spaces round at different points.
 *
 *   plain  fee is taken on the converted token amount, as
 *          `MASP._computeAmounts` does
 *   yield  fee is taken in normalized units, rounded up (as `YieldOps._deposit`
 *          does through `Fees.unitFee`), and the *total* is converted once,
 *          rounding up again; this keeps `_drainDeposit` index-free and the
 *          escrow digest stable
 *
 * The yield branch converts with `rate`, never with the reported index; see
 * {@link YieldRate}.
 *
 * @throws {InvalidArgumentError} when the asset yields but no `rate` was
 * supplied. `scale` is not a safe fallback: it under-quotes by whatever the
 * venue has earned, which makes the pull revert.
 */
export function depositTotal(args: DepositTotalArgs): TokenAmount {
    const { publicIn, feeIn, depositBps, scale, yieldEnabled = false, rate } = args;
    if (!yieldEnabled) {
        const inAmt = publicIn * scale;
        return branded<TokenAmount>(inAmt + applyFee(inAmt, depositBps) + feeIn * scale);
    }
    if (rate === undefined) {
        throw new InvalidArgumentError(
            "this asset earns yield, so its deposit cost depends on the pool's current " +
                "index; the source did not report one",
            { argument: "rate" },
        );
    }
    const units = publicIn + unitFee(publicIn, depositBps) + feeIn;
    return toTokenUnitsAtRate(branded<CircuitAmount>(units), scale, rate, { round: "up" });
}

/**
 * Whether a deposit's relayer note is charged in the deposit token, on the
 * single-token path. Mirrors `MASP._sameFeeAsset`.
 *
 * Decided by asset id, not token address: a plain id and a yield id may share
 * one ERC-20 yet price and book differently. On this path the payer signs one
 * `PermitWitnessTransferFrom` (or holds one allowance) covering principal,
 * protocol fee and relayer note together, with `maxFee = 0`. Otherwise the fee
 * token is pulled separately, under a two-entry batch permit.
 */
export function isSameFeeAsset(feeIn: bigint, feeAssetId: bigint, publicAssetId: bigint): boolean {
    return feeIn === 0n || feeAssetId === publicAssetId;
}

/**
 * The inputs of `depositTotal`, plus where the relayer note is priced.
 *
 * The split follows the pool's own branch over the two asset ids
 * ({@link isSameFeeAsset}).
 */
export interface DepositTotalsArgs extends DepositTotalArgs {
    /**
     * The fee asset's `scale`. Read only when the pool pulls the note
     * separately, and then required.
     *
     * The pool accepts only a plain asset there, so the note is priced exactly
     * at `feeIn * feeScale` and never through a yield rate.
     */
    feeScale?: bigint | undefined;
    /** Registry id of the deposited asset. */
    publicAssetId: bigint;
    /**
     * Registry id of the asset paying the relayer: `publicAssetId` when the fee
     * is in the deposited asset.
     */
    feeAssetId: bigint;
}

/**
 * A shield's cost split by what it pays for, in ERC-20 base units.
 *
 * `principal` is always in the deposit token; `relayer` is in the fee token,
 * which is the deposit token when the pool takes the single-token path. In that
 * case the pool pulls the two as one amount, and `principal + relayer` equals
 * `depositTotal` exactly.
 */
export interface DepositTotals {
    /** The principal and the protocol fee, in the deposit token. */
    principal: TokenAmount;
    /** The relayer's fee note, in the token it is paid in. */
    relayer: TokenAmount;
}

/**
 * `depositTotal`, split per token: what the pool pulls for the principal
 * and protocol fee, and what it pulls for the relayer's note.
 *
 * Mirrors `MASP._quoteShield`. When the note is pulled separately it is priced
 * under the fee asset alone (`feeIn * feeScale`) and the principal is quoted
 * with `feeIn = 0`, so each figure is one token's pull. Otherwise the note
 * joins the principal's quote, and on a yield asset the two are converted
 * together, rounding once; `relayer` is then the difference that note makes,
 * so the sum still matches the single pull.
 *
 * Which of the two applies is {@link isSameFeeAsset} over `publicAssetId` and
 * `feeAssetId`.
 *
 * @throws {InvalidArgumentError} as `depositTotal`; or when the ids say the
 * note is pulled separately and no `feeScale` was given.
 */
export function depositTotals(args: DepositTotalsArgs): DepositTotals {
    const { feeIn, feeScale, publicAssetId, feeAssetId } = args;
    const principal = depositTotal({ ...args, feeIn: 0n });
    if (isSameFeeAsset(feeIn, feeAssetId, publicAssetId)) {
        return { principal, relayer: branded<TokenAmount>(depositTotal(args) - principal) };
    }
    if (feeScale === undefined) {
        throw new InvalidArgumentError(
            `the relayer note is paid in asset ${feeAssetId}, not the deposited ` +
                `${publicAssetId}, so its feeScale is needed to price it`,
            { argument: "feeScale" },
        );
    }
    return { principal, relayer: branded<TokenAmount>(feeIn * feeScale) };
}

/**
 * Headroom added to a yield asset's signed deposit ceiling, in basis points.
 *
 * 50 bps is roughly a thousand times the drift a 5% APY produces over the
 * default Permit2 deadline, while still bounding what a misbehaving pool could
 * pull beyond the quote.
 */
const DEPOSIT_INDEX_HEADROOM_BPS = 50n;

/**
 * What to sign for a deposit, given what it currently costs.
 *
 * The result is a ceiling, not an estimate: Permit2 transfers only what the
 * pool asks for, an allowance is a cap, and `NativeAdapter` refunds the unused
 * part of `msg.value`. Overshooting costs the payer nothing; undershooting
 * reverts the deposit.
 *
 * A yield asset's cost is `units * gross / supply` and `gross` grows every
 * block, so a ceiling at exactly the quote is stale once signed. Plain assets
 * add no headroom: their cost is exact and fixed.
 */
export function depositCeiling(quoted: TokenAmount, yieldEnabled: boolean): TokenAmount {
    if (!yieldEnabled) return quoted;
    return branded<TokenAmount>(quoted + applyFee(quoted, DEPOSIT_INDEX_HEADROOM_BPS));
}
