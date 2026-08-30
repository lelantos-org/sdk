// Fee arithmetic and the on-chain amount bounds it has to respect.

import { InvalidArgumentError } from "./errors.js";
import { RAY } from "./units.js";

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
