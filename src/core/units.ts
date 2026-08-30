// Decimal <-> integer conversion helpers. Dependency-free and wallet-free
// so they can be used anywhere a raw amount needs formatting or parsing.
//
// The MASP works in three amount spaces; mixing them up is the most common
// integration bug:
//
//   human       "1.5"                 what a user types
//   token       1500000000000000000n  ERC-20 base units (10 ** decimals)
//   circuit     1500n                 what every `Wallet` method takes
//
// `token = circuit * asset.scale`. See `./wallet/assets.ts` for the
// asset-aware wrappers (`parseAmount` / `formatAmount`).
//
// The two integer spaces are branded (`CircuitAmount`, `TokenAmount`), so the
// conversions below are the only way to move between them and passing one
// where the other is expected is a compile error.

import { branded, type CircuitAmount, type TokenAmount } from "./brand.js";

const DECIMAL = /^-?(\d+)(?:\.(\d+))?$/;

/**
 * Fixed-point scale of a pool-managed yield index, matching the Aave
 * scaled-balance convention. An index of exactly `RAY` means "no yield
 * accrued", where every conversion below reduces to the plain `scale`
 * arithmetic the pool used before an index existed.
 */
export const RAY = 10n ** 27n;

/**
 * Decimal string → integer with `decimals` implied places.
 *
 * ```ts
 * parseUnits("1.5", 18); // 1500000000000000000n
 * ```
 *
 * @throws {RangeError} on a malformed number, or more fraction digits than
 * `decimals` can hold — the amount is never truncated silently.
 */
export function parseUnits(value: string | number | bigint, decimals: number): bigint {
    if (typeof value === "bigint") return value * 10n ** BigInt(decimals);
    const text = typeof value === "number" ? numberToDecimalString(value) : value.trim();
    const m = DECIMAL.exec(text);
    if (!m) throw new RangeError(`parseUnits: "${text}" is not a decimal number`);
    const [, whole, frac = ""] = m;
    if (frac.length > decimals) {
        throw new RangeError(
            `parseUnits: "${text}" has ${frac.length} decimal places but only ` +
                `${decimals} are representable`,
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
 * Circuit units → ERC-20 base units.
 *
 * `token = circuit * scale * index / RAY`. At the default `index` of {@link RAY}
 * the index cancels exactly and this is the plain `circuit * scale` it has
 * always been, so a caller that knows nothing about yield keeps today's
 * behaviour.
 *
 * Once a pool-managed index is live the conversion is lossy in this direction,
 * and the rounding is not symmetric with {@link toCircuitUnits}: round **down**
 * on the way out of the pool and **up** on the way in, so dust always accrues
 * to the remaining holders rather than to whoever is transacting.
 */
export function toTokenUnits(
    circuitAmount: CircuitAmount,
    scale: bigint,
    opts: { index?: bigint; round?: "down" | "up" } = {},
): TokenAmount {
    const index = opts.index ?? RAY;
    if (index <= 0n) throw new RangeError(`toTokenUnits: index must be positive, got ${index}`);
    const numer = circuitAmount * scale * index;
    const down = numer / RAY;
    if ((opts.round ?? "down") === "down") return branded<TokenAmount>(down);
    return branded<TokenAmount>(numer % RAY === 0n ? down : down + 1n);
}

/**
 * ERC-20 base units → circuit units.
 *
 * @throws {RangeError} when the amount is not a whole number of circuit
 * units. Pass `{ round: "down" }` to floor instead; the remainder is dropped
 * without notice, so use it only where dust does not matter.
 */
export function toCircuitUnits(
    tokenAmount: TokenAmount,
    scale: bigint,
    opts: { round?: "exact" | "down"; index?: bigint } = {},
): CircuitAmount {
    if (scale <= 0n) throw new RangeError(`toCircuitUnits: scale must be positive, got ${scale}`);
    const index = opts.index ?? RAY;
    if (index <= 0n) throw new RangeError(`toCircuitUnits: index must be positive, got ${index}`);
    // `circuit = token * RAY / (scale * index)`. At `index === RAY` the RAYs
    // cancel and `step` is `scale`, so the error message below still names the
    // figure a caller recognises.
    const numer = tokenAmount * RAY;
    const step = scale * index;
    const rest = numer % step;
    if (rest !== 0n && (opts.round ?? "exact") === "exact") {
        // Two messages: at the default index the index is noise, and naming it
        // would only puzzle a caller who has never enabled yield. Once it is
        // moving it is usually the whole reason a previously round amount
        // stopped being representable, so it leads.
        throw new RangeError(
            index === RAY
                ? `toCircuitUnits: ${tokenAmount} is not a multiple of scale ${scale} ` +
                      `(remainder ${rest / RAY}); the smallest representable step is ` +
                      `${scale} base units`
                : `toCircuitUnits: ${tokenAmount} is not a whole number of circuit units at ` +
                      `scale ${scale} and index ${index}; the smallest representable step is ` +
                      `${step} / ${RAY} base units`,
        );
    }
    return branded<CircuitAmount>((numer - rest) / step);
}

/** Reject float artefacts (`1e-7`, `0.1 + 0.2`) before they reach `BigInt`. */
function numberToDecimalString(value: number): string {
    if (!Number.isFinite(value)) throw new RangeError(`parseUnits: ${value} is not finite`);
    const text = String(value);
    if (text.includes("e") || text.includes("E")) {
        throw new RangeError(
            `parseUnits: ${text} uses exponent notation; pass a decimal string instead`,
        );
    }
    return text;
}
