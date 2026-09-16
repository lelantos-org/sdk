// Decimal <-> integer conversion helpers. Dependency-free and wallet-free
// so they can be used anywhere a raw amount needs formatting or parsing.
//
// The MASP works in three amount spaces, which integrations commonly confuse:
//
//   human       "1.5"                 what a user types
//   token       1500000000000000000n  ERC-20 base units (10 ** decimals)
//   circuit     1500n                 what every wallet method takes
//
// `token = circuit * asset.scale`. See `wallet/assets/` for the
// asset-aware wrappers (`parseAmount` / `formatAmount`).
//
// The two integer spaces are branded (`CircuitAmount`, `TokenAmount`), so the
// conversions below are the only way to move between them and passing one
// where the other is expected is a compile error.

import { branded, type CircuitAmount, type TokenAmount } from "../core/brand.js";
import { InvalidArgumentError } from "../errors/config.js";

const DECIMAL = /^-?(\d+)(?:\.(\d+))?$/;

/**
 * Fixed-point scale of a pool-managed yield index, matching the Aave
 * scaled-balance convention. An index of exactly `RAY` means "no yield
 * accrued", where every conversion below reduces to plain `scale` arithmetic.
 */
export const RAY = 10n ** 27n;

/**
 * Decimal string → integer with `decimals` implied places.
 *
 * ```ts
 * parseUnits("1.5", 18); // 1500000000000000000n
 * ```
 *
 * @throws {InvalidArgumentError} on a malformed number, or more fraction digits than
 * `decimals` can hold — the amount is never truncated silently.
 */
export function parseUnits(value: string | number | bigint, decimals: number): bigint {
    if (typeof value === "bigint") return value * 10n ** BigInt(decimals);
    const text = typeof value === "number" ? numberToDecimalString(value) : value.trim();
    const m = DECIMAL.exec(text);
    if (!m)
        throw new InvalidArgumentError(`parseUnits: "${text}" is not a decimal number`, {
            argument: "value",
        });
    const [, whole, frac = ""] = m;
    if (frac.length > decimals) {
        throw new InvalidArgumentError(
            `parseUnits: "${text}" has ${frac.length} decimal places but only ` +
                `${decimals} are representable`,
            { argument: "value" },
        );
    }
    const digits = BigInt(whole + frac.padEnd(decimals, "0"));
    return text.startsWith("-") ? -digits : digits;
}

/**
 * Integer with `decimals` implied places → decimal string. Trailing
 * fractional zeros are dropped.
 *
 * ```ts
 * formatUnits(1500000000000000000n, 18); // "1.5"
 * ```
 */
export function formatUnits(value: bigint, decimals: number): string {
    const neg = value < 0n;
    const digits = (neg ? -value : value).toString().padStart(decimals + 1, "0");
    const whole = digits.slice(0, digits.length - decimals);
    const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
    return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * `numer / denom`, floored or ceiled, for a non-negative `numer`.
 *
 * The rounding direction is this module's core contract: down out of the pool,
 * up into it, so dust accrues to the remaining holders. All conversions share
 * this one implementation, the wallet's amount arithmetic included.
 */
export function divRound(numer: bigint, denom: bigint, round: "down" | "up"): bigint {
    const down = numer / denom;
    return round === "up" && numer % denom !== 0n ? down + 1n : down;
}

/**
 * Circuit units → ERC-20 base units.
 *
 * `token = circuit * scale * index / RAY`. At the default `index` of {@link RAY}
 * the index cancels exactly, giving `circuit * scale`.
 *
 * With a pool-managed index the conversion is lossy, so it rounds **down** by
 * default: the direction out of the pool (see `divRound`).
 *
 * A *display* conversion: to size a payment, use {@link toTokenUnitsAtRate}
 * (see {@link YieldRate} for why).
 */
export function toTokenUnits(
    circuitAmount: CircuitAmount,
    scale: bigint,
    opts: { index?: bigint; round?: "down" | "up" } = {},
): TokenAmount {
    const index = opts.index ?? RAY;
    if (index <= 0n)
        throw new InvalidArgumentError(`toTokenUnits: index must be positive, got ${index}`, {
            argument: "index",
        });
    return branded<TokenAmount>(divRound(circuitAmount * scale * index, RAY, opts.round ?? "down"));
}

/**
 * Current value of a yield asset's units as the pool measures it: `gross` is
 * the venue position plus the pool's idle balance, `supply` the units
 * outstanding against it.
 *
 * Used instead of the {@link RAY}-scaled `index` because the pool converts by
 * `units * gross / supply` (`scale` and `RAY` cancel), while the index it
 * *reports* is floored. A deposit quoted through the floored index can land
 * below what the contract charges, and a `maxTotal` signed from that figure is
 * refused by Permit2. Use `index` for display; use this to size payments.
 */
export interface YieldRate {
    gross: bigint;
    supply: bigint;
}

/**
 * Circuit units → ERC-20 base units at a pool-measured rate.
 *
 * Prefer this over {@link toTokenUnits} for any figure someone is *charged*;
 * see {@link YieldRate}.
 *
 * `undefined`, or a rate with no units outstanding, yields `circuit * scale`:
 * an empty pool has no ratio and one unit is worth exactly `scale` by
 * definition, which pins a new asset's index to {@link RAY}.
 *
 * A nonzero `supply` with zero `gross` is **not** that case and is not
 * special-cased: the venue lost everything, the contract pays out zero, and so
 * does this. Treating it as an empty pool would price worthless units at face
 * value.
 *
 * Rounds **up** by default because the caller is paying in: rounding down
 * under-signs the Permit2 ceiling. {@link toTokenUnits} defaults to down for the
 * converse reason.
 */
export function toTokenUnitsAtRate(
    circuitAmount: CircuitAmount,
    scale: bigint,
    rate: YieldRate | undefined,
    opts: { round?: "down" | "up" } = {},
): TokenAmount {
    const round = opts.round ?? "up";
    // `supply` alone, matching `YieldOps._toUnderlying`: the contract's only
    // fallback is `s == 0`.
    if (rate === undefined || rate.supply === 0n) {
        return branded<TokenAmount>(circuitAmount * scale);
    }
    if (rate.supply < 0n || rate.gross < 0n) {
        throw new InvalidArgumentError(
            `toTokenUnitsAtRate: rate must be non-negative, got gross ${rate.gross} ` +
                `supply ${rate.supply}`,
            { argument: "rate" },
        );
    }
    return branded<TokenAmount>(divRound(circuitAmount * rate.gross, rate.supply, round));
}

/**
 * ERC-20 base units → circuit units.
 *
 * `round` picks what happens off a unit boundary:
 *
 * - `"exact"` (default) throws. Use wherever an off-boundary amount is a
 *   mistake; at a fixed `scale` nothing finer is representable, and truncating
 *   would silently short the caller.
 * - `"down"` floors, dropping the remainder silently. Use only where dust does
 *   not matter.
 * - `"up"` ceils, inverting a conversion that floored.
 *   {@link toTokenUnits} produces `floor(units * step / RAY)`, at or below the
 *   exact worth of `units`; flooring again on the way back loses a unit. `"up"`
 *   gives the smallest unit count worth at least `tokenAmount` and recovers the
 *   original exactly: `toCircuitUnits(toTokenUnits(v, …), …, { round: "up" }) === v`.
 *
 *   With a moving index a unit is worth a non-round number of base units, so
 *   most unit counts have no exact decimal at the token's `decimals`, including
 *   values a "max" control writes into a field and reads back. Rounding up
 *   cannot over-draw: if `tokenAmount <= toTokenUnits(balance, …)` then the
 *   result is `<= balance`.
 *
 * @throws {InvalidArgumentError} when the amount is not a whole number of circuit units
 * and `round` is `"exact"`.
 */
export function toCircuitUnits(
    tokenAmount: TokenAmount,
    scale: bigint,
    opts: { round?: "exact" | "down" | "up"; index?: bigint } = {},
): CircuitAmount {
    if (scale <= 0n)
        throw new InvalidArgumentError(`toCircuitUnits: scale must be positive, got ${scale}`, {
            argument: "scale",
        });
    const index = opts.index ?? RAY;
    if (index <= 0n)
        throw new InvalidArgumentError(`toCircuitUnits: index must be positive, got ${index}`, {
            argument: "index",
        });
    // `circuit = token * RAY / (scale * index)`. At `index === RAY` the RAYs
    // cancel and `step` is `scale`, so the error message below still names the
    // figure a caller recognises.
    const numer = tokenAmount * RAY;
    const step = scale * index;
    const rest = numer % step;
    if (rest !== 0n && (opts.round ?? "exact") === "exact") {
        // At the default index the index is irrelevant to the caller, so the
        // message omits it. With a moving index it is usually why the amount is
        // not representable, so the message names it.
        throw new InvalidArgumentError(
            index === RAY
                ? `toCircuitUnits: ${tokenAmount} is not a multiple of scale ${scale} ` +
                      `(remainder ${rest / RAY}); the smallest representable step is ` +
                      `${scale} base units`
                : `toCircuitUnits: ${tokenAmount} is not a whole number of circuit units at ` +
                      `scale ${scale} and index ${index}; the smallest representable step is ` +
                      `${step} / ${RAY} base units`,
            { argument: "tokenAmount" },
        );
    }
    return branded<CircuitAmount>(divRound(numer, step, opts.round === "up" ? "up" : "down"));
}

/** Reject float artefacts (`1e-7`, `0.1 + 0.2`) before they reach `BigInt`. */
function numberToDecimalString(value: number): string {
    if (!Number.isFinite(value))
        throw new InvalidArgumentError(`parseUnits: ${value} is not finite`, { argument: "value" });
    const text = String(value);
    if (text.includes("e") || text.includes("E")) {
        throw new InvalidArgumentError(
            `parseUnits: ${text} uses exponent notation; pass a decimal string instead`,
            { argument: "value" },
        );
    }
    return text;
}
