// Ladder and fee helpers for an asset: the smallest expressible amount, the withdrawal ladder, and
// the net a withdrawal delivers.
//
// Pure functions of an `AssetInfo`, kept separate from `./info.ts` so they do not bundle the
// registry fetch. Human string ↔ circuit unit conversion lives in `./amount.ts`.

import {
    branded,
    type CircuitAmount,
    type CircuitAmountLike,
    circuitAmount,
} from "../../core/brand.js";
import { isDenomination, nearest } from "../../protocol/denominations.js";
import { type WithdrawNet, withdrawNet } from "../../protocol/fees.js";
import { type AssetUnits, formatAmount, withdrawTerms } from "./amount.js";
import type { AssetInfo } from "./info.js";

/** Smallest non-zero amount the asset can express, as a decimal string. */
export function minAmount(asset: AssetUnits): string {
    return formatAmount(branded<CircuitAmount>(1n), asset);
}

/**
 * Whether `amount` is one of the asset's denominations.
 *
 * `false` for every amount of an asset with no ladder. To distinguish "off the
 * ladder" from "no ladder exists", check `asset.ladder.length > 0` first.
 */
export function isOnLadder(amount: CircuitAmountLike, asset: AssetInfo): boolean {
    return isDenomination(circuitAmount(amount), asset.ladder);
}

/**
 * The denomination closest to `amount`, or `undefined` when the asset has no
 * ladder. Ties go to the smaller, so a suggestion never exceeds the request.
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
 * The asset-aware wrapper over {@link withdrawNet}; the fields are mapped by
 * `withdrawTerms`. An omitted `yieldEnabled` would misreport the net on the
 * yield branch, and reading the rate from the asset prevents passing the
 * deposit rate to a withdrawal.
 */
export function withdrawNetFor(publicOut: CircuitAmountLike, asset: AssetInfo): WithdrawNet {
    return withdrawNet({ publicOut: circuitAmount(publicOut), ...withdrawTerms(asset) });
}
