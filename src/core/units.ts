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

const DECIMAL = /^-?(\d+)(?:\.(\d+))?$/;

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
 * Circuit units → ERC-20 base units. Always exact — `scale` is a
 * multiplier, so this direction cannot lose precision.
 */
export function toTokenUnits(circuitAmount: bigint, scale: bigint): bigint {
    return circuitAmount * scale;
}

/**
 * ERC-20 base units → circuit units.
 *
 * @throws {RangeError} when the amount is not a whole number of circuit
 * units. Pass `{ round: "down" }` to floor instead; the remainder is dropped
 * without notice, so use it only where dust does not matter.
 */
export function toCircuitUnits(
    tokenAmount: bigint,
    scale: bigint,
    opts: { round?: "exact" | "down" } = {},
): bigint {
    if (scale <= 0n) throw new RangeError(`toCircuitUnits: scale must be positive, got ${scale}`);
    const rest = tokenAmount % scale;
    if (rest !== 0n && (opts.round ?? "exact") === "exact") {
        throw new RangeError(
            `toCircuitUnits: ${tokenAmount} is not a multiple of scale ${scale} ` +
                `(remainder ${rest}); the smallest representable step is ${scale} base units`,
        );
    }
    return (tokenAmount - rest) / scale;
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
