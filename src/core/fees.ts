// Fee arithmetic and the on-chain amount bounds it has to respect.

import { InvalidArgumentError } from "./errors.js";

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
 * Guard a value destined for `DepositIntent.publicIn` against the uint48
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
