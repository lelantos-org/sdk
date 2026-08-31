// Fee arithmetic and the on-chain amount bounds it has to respect.

import { branded, type CircuitAmount, type TokenAmount } from "./brand.js";
import { InvalidArgumentError } from "./errors.js";
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
 * A bare `bigint` sets both legs — the common case for a test pool or a
 * fixture, where the two are configured equal and naming them twice is noise.
 * Pass the pair to price the legs apart.
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
 * top. So a caller picks the gross — a ladder denomination, since that is the
 * figure published on chain — and receives slightly less. This is where
 * "slightly less" is computed, and it is the function a UI needs to show the
 * two numbers side by side.
 *
 * The two branches mirror the contract exactly and are **not**
 * interchangeable: they round at different points, so the wrong one misreports
 * the net by up to a unit.
 *
 *   plain  the fee is taken from the converted token amount
 *   yield  the fee is taken in normalized units *before* conversion, which is
 *          what keeps `_drainDeposit` index-free and the escrow digest stable
 */
export function withdrawNet(args: WithdrawNetArgs): WithdrawNet {
    const { publicOut, feeBps, scale, index = RAY, yieldEnabled = false } = args;
    const toTokens = (units: bigint): bigint => (units * scale * index) / RAY;

    if (yieldEnabled) {
        const feeNorm = applyFee(publicOut, feeBps);
        const net = toTokens(publicOut - feeNorm);
        return { net, fee: toTokens(publicOut) - net };
    }
    const gross = toTokens(publicOut);
    const fee = applyFee(gross, feeBps);
    return { net: gross - fee, fee };
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
 * The counterpart to {@link withdrawNet}, and it branches for the same reason:
 * a shield is charged **on top of** the principal while a withdrawal is skimmed
 * out of it, and the two unit spaces round at different points.
 *
 *   plain  fee is taken on the converted token amount, as
 *          `MASP._computeAmounts` does
 *   yield  fee is taken in normalized units and the *total* is converted once,
 *          rounding up — which is what keeps `_drainDeposit` index-free and the
 *          escrow digest stable
 *
 * The yield branch converts with `rate`, never with the reported index: that
 * index is floored on chain, so a charge sized through it can land below what
 * the contract takes and the Permit2 pull is refused.
 *
 * @throws {InvalidArgumentError} when the asset yields but no `rate` was
 * supplied. `scale` is not a safe fallback — it under-quotes by whatever the
 * venue has earned, which is precisely the amount that makes the pull revert.
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
    const units = publicIn + applyFee(publicIn, depositBps) + feeIn;
    return toTokenUnitsAtRate(branded<CircuitAmount>(units), scale, rate, { round: "up" });
}

/**
 * Headroom added to a yield asset's signed deposit ceiling, in basis points.
 *
 * 50 bps is roughly a thousand times the drift a 5% APY produces over the
 * default Permit2 deadline, while still bounding what a misbehaving pool could
 * pull beyond the quote.
 */
export const DEPOSIT_INDEX_HEADROOM_BPS = 50n;

/**
 * What to sign for a deposit, given what it currently costs.
 *
 * Every consumer of this figure wants a ceiling rather than an estimate:
 * Permit2 transfers only what the pool asks for, an allowance is a cap, and
 * `NativeAdapter` refunds the unused part of `msg.value`. So overshooting costs
 * the payer nothing, while undershooting reverts the deposit.
 *
 * A yield asset's cost is `units * gross / supply` and `gross` grows with the
 * venue on every block, so a ceiling signed at exactly the quote is stale the
 * moment it is signed. Plain assets add nothing: their cost is exact and does
 * not move.
 */
export function depositCeiling(quoted: TokenAmount, yieldEnabled: boolean): TokenAmount {
    if (!yieldEnabled) return quoted;
    return branded<TokenAmount>(quoted + applyFee(quoted, DEPOSIT_INDEX_HEADROOM_BPS));
}
