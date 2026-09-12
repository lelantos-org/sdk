// Every amount-shaped question about an asset: human string ↔ circuit units,
// where the withdrawal ladder sits, and what a withdrawal actually delivers.
//
// Split from `./info.ts` because these are pure functions OF an `AssetInfo` —
// no chain reads, no construction — and because a caller formatting a balance
// has no business pulling the registry fetch into its bundle.

import {
    branded,
    type CircuitAmount,
    type CircuitAmountLike,
    circuitAmount,
} from "../../core/brand.js";
import { isDenomination, type Ladder, nearest } from "../../core/denominations.js";
import { type WithdrawNet, withdrawNet } from "../../core/fees.js";
import { formatUnits, parseUnits, RAY, toCircuitUnits, toTokenUnits } from "../../core/units.js";
import { type AssetInfo, requireTokenMeta } from "./info.js";

/**
 * Human decimal string → circuit units, ready to pass as `amount`.
 *
 * ```ts
 * const weth = await wallet.asset(1n);
 * await wallet.deposit({ asset: weth.id, amount: parseAmount("0.25", weth) });
 * ```
 *
 * @throws {RangeError} when the value is finer-grained than one circuit unit.
 * @throws {InvalidArgumentError} when the chain adapter resolved no `decimals`.
 */
export function parseAmount(value: string | number | bigint, asset: AssetInfo): CircuitAmount {
    const meta = requireTokenMeta(asset);
    return toCircuitUnits(branded(parseUnits(value, meta.decimals)), meta.scale, {
        index: meta.index,
        // Two genuinely different situations, which is why the policy lives here
        // rather than in `toCircuitUnits` — that primitive keeps honouring
        // whatever a caller asks for explicitly.
        //
        // A plain asset's granularity is fixed at `scale`, so an amount finer
        // than that was never representable and silently truncating it would
        // short the user without saying so. It throws, as it always has.
        //
        // Under a moving index a unit is worth a non-round number of base
        // units, so most human amounts have no exact equivalent — including the
        // ones `formatAmount` itself produces. Refusing them would make a yield
        // asset unusable through this API, and rounding down is the safe reading
        // of an ambiguous amount: the caller gets slightly less than they asked
        // for, never more than they hold.
        // `?? RAY` is load-bearing: an asset whose index is unknown must keep
        // the strict behaviour rather than fall through to the lossy branch.
        // Treating "no index" as "yielding" would silently truncate on exactly
        // the assets we know least about.
        round: (meta.index ?? RAY) === RAY ? "exact" : "down",
    });
}

/**
 * Circuit units → human decimal string. Pass `{ symbol: true }` to append
 * the token symbol when one is known.
 *
 * ```ts
 * formatAmount(wallet.balance(weth.id), weth, { symbol: true }); // "0.25 WETH"
 * ```
 */
export function formatAmount(
    amount: CircuitAmountLike,
    asset: AssetInfo,
    opts: { symbol?: boolean } = {},
): string {
    const meta = requireTokenMeta(asset);
    const text = formatUnits(
        toTokenUnits(circuitAmount(amount), meta.scale, { index: meta.index }),
        meta.decimals,
    );
    return opts.symbol && meta.symbol ? `${text} ${meta.symbol}` : text;
}

/** Smallest non-zero amount the asset can express, as a decimal string. */
export function minAmount(asset: AssetInfo): string {
    return formatAmount(branded(1n), asset);
}

/**
 * The asset's withdrawal denominations, ascending, or `[]` when it has none.
 *
 * A withdrawal's `publicOut` is public, and normalized units do not move, so
 * the naive round trip publishes the same integer at both ends. Choosing from
 * this list is what makes that integer one many other users also publish —
 * see `core/denominations.ts` for why it is a table of fixed integers rather
 * than something derived from human amounts.
 *
 * ```ts
 * const usdc = await wallet.asset("USDC");
 * for (const d of denominations(usdc)) {
 *     console.log(formatAmount(d, usdc, { symbol: true })); // "10 USDC", "20 USDC", …
 * }
 * ```
 *
 * The human labels move as the yield index does; the denominations themselves
 * never do.
 */
export function denominations(asset: AssetInfo): Ladder {
    return asset.ladder;
}

/** Whether the asset has a withdrawal ladder at all. */
export function isDenominated(asset: AssetInfo): boolean {
    return asset.ladder.length > 0;
}

/**
 * Whether `amount` is one of the asset's denominations.
 *
 * `false` for every amount of an asset with no ladder — there is nothing to be
 * on. Callers wanting to distinguish "off the ladder" from "no ladder exists"
 * should check {@link isDenominated} first.
 */
export function isOnLadder(amount: CircuitAmountLike, asset: AssetInfo): boolean {
    return isDenomination(circuitAmount(amount), asset.ladder);
}

/**
 * The denomination closest to `amount`, or `undefined` when the asset has no
 * ladder. Ties go to the smaller, so a suggestion never silently costs more
 * than was asked for.
 */
export function nearestDenomination(
    amount: CircuitAmountLike,
    asset: AssetInfo,
): CircuitAmount | undefined {
    const found = nearest(circuitAmount(amount), asset.ladder);
    return found === undefined ? undefined : branded<CircuitAmount>(found);
}

/**
 * Split a withdrawal's gross into what the recipient receives and what the
 * protocol keeps, reading `withdrawBps`, `scale`, `index` and `yieldEnabled`
 * off the asset.
 *
 * The asset-aware wrapper over {@link withdrawNet}, and the only place those
 * four fields are mapped onto it — assembling them at each call site is how one
 * of them ends up stale or omitted, and the yield branch silently misreports the
 * net when `yieldEnabled` is the one that goes missing. Taking the rate from the
 * asset rather than as an argument also removes the way this used to go wrong
 * most easily: passing the deposit rate to a withdrawal.
 */
export function withdrawNetFor(publicOut: CircuitAmountLike, asset: AssetInfo): WithdrawNet {
    return withdrawNet({
        publicOut: circuitAmount(publicOut),
        feeBps: asset.withdrawBps,
        scale: asset.scale,
        index: asset.index,
        yieldEnabled: asset.yieldEnabled,
    });
}
