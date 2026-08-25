// Amounts, in the two denominations a caller might mean.
//
//   bigint  circuit units, exact — what every wallet method has always taken
//   string  a human decimal amount of the token, e.g. "0.25"
//
// The split is by *type*, not by value, because there is no safe way to guess.
// `100` could be a hundred circuit units or a hundred tokens, and those differ
// by `scale` — twelve orders of magnitude on an 18-decimal token against a
// 6-decimal circuit. So a bigint is always exact and a string is always human,
// and neither reading depends on how large the number happens to be.
//
// `number` is refused outright. `0.1` is not representable in binary floating
// point, and silently rounding someone's transfer is worse than making them
// write `"0.1"`.

import type { CircuitAmount, CircuitAmountLike } from "../core/brand.js";
import { circuitAmount } from "../core/brand.js";
import { InvalidArgumentError } from "../core/errors.js";
import { type AssetInfo, parseAmount } from "./assets.js";

/**
 * An amount, either exact circuit units (`bigint`) or a human decimal amount
 * of the token (`string`).
 *
 * ```ts
 * await wallet.transfer({ to, asset: "USDC", amount: "12.50" });  // 12.50 USDC
 * await wallet.transfer({ to, asset: "USDC", amount: 1250n });    // circuit units
 * ```
 */
export type AmountLike = CircuitAmountLike | string;

/**
 * Resolve `amount` against `asset`.
 *
 * @throws {InvalidArgumentError} for a `number`, which cannot represent a
 * decimal amount exactly, or for a string the asset has no `decimals` for.
 * @throws {RangeError} when the value is finer-grained than one circuit unit —
 * dust that the pool cannot express, and that silently truncating would lose.
 */
export function resolveAmount(amount: AmountLike, asset: AssetInfo): CircuitAmount {
    if (typeof amount === "number") {
        throw new InvalidArgumentError(
            `amount must be a bigint (circuit units) or a decimal string (token units), not a ` +
                `number: ${amount} cannot be represented exactly in binary floating point. ` +
                `Pass "${amount}".`,
            { argument: "amount" },
        );
    }
    if (typeof amount === "string") return parseAmount(amount, asset);
    return circuitAmount(amount);
}
