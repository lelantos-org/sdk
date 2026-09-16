// Amount conversion between the three spaces a caller may hold a value in, and the resolution of an
// `Amount` / `OutAmount` against an asset.
//
//   human    "12.5"          what a user types and what `formatAmount` prints
//   circuit  CircuitAmount   note values, `publicIn` / `publicOut`
//   base     TokenAmount     ERC-20 base units: `circuit * scale * index / RAY`
//
// Every conversion here is one exact rational division, rounded once by the caller's `Rounding`, so
// `parseAmount(formatAmount(x, a), a) === x` holds for plain assets and for yield assets whose unit
// is worth at least one base unit (`scale * index >= RAY`, every registered asset).
//
// Pure functions of `AssetUnits`: formatting a balance bundles no registry code.

import { branded, type CircuitAmount, circuitAmount, type TokenAmount } from "../../core/brand.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { grossForNet, withdrawNet } from "../../protocol/fees.js";
import { divRound, formatUnits, RAY } from "../../protocol/units.js";
import type { Money } from "../types/results.js";
import type { AssetInfo } from "./info.js";

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/** An asset whose index moves: off-unit amounts round up by default rather than refusing. */
export function isYieldUnits(asset: AssetUnits): boolean {
    return (asset.index ?? RAY) !== RAY;
}

/** The rounding an `Amount` gets when the caller names none. See `Amount`. */
function defaultRounding(asset: AssetUnits): Rounding {
    return isYieldUnits(asset) ? "up" : "exact";
}

function assertUnits(asset: AssetUnits, fn: string): { scale: bigint; index: bigint } {
    const index = asset.index ?? RAY;
    if (typeof asset.scale !== "bigint" || asset.scale <= 0n) {
        throw new InvalidArgumentError(`${fn}: asset scale must be a positive bigint`, {
            argument: "asset",
        });
    }
    if (index <= 0n) {
        throw new InvalidArgumentError(`${fn}: asset index must be positive, got ${index}`, {
            argument: "asset",
        });
    }
    return { scale: asset.scale, index };
}

function assertDecimals(asset: AssetUnits, fn: string): number {
    const d = asset.decimals;
    if (d === undefined || !Number.isInteger(d) || d < 0 || d > 255) {
        throw new InvalidArgumentError(
            `${fn}: the asset has no known ERC-20 decimals; resolve it with \`wallet.asset()\` ` +
                "or work in circuit or base units",
            { argument: "asset" },
        );
    }
    return d;
}

/**
 * `|numer| / denom` rounded per `round`, sign restored. Rounding acts on the magnitude: `"down"`
 * moves toward zero, `"up"` away from it.
 */
function divide(
    numer: bigint,
    denom: bigint,
    round: Rounding,
    describe: () => string,
    argument: string,
): bigint {
    const neg = numer < 0n;
    const mag = neg ? -numer : numer;
    if (round === "exact" && mag % denom !== 0n) {
        throw new InvalidArgumentError(describe(), { argument });
    }
    const out = divRound(mag, denom, round === "up" ? "up" : "down");
    return neg ? -out : out;
}

function roundingOf(round: unknown, fallback: Rounding): Rounding {
    if (round === undefined) return fallback;
    if (round === "exact" || round === "down" || round === "up") return round;
    throw new InvalidArgumentError(`round must be "exact", "down" or "up", got ${String(round)}`, {
        argument: "round",
    });
}

/**
 * Human decimal string → circuit units.
 *
 * Default `round`: `"exact"` for a plain asset (an amount finer than one unit is refused, never
 * truncated), `"up"` for a yield asset (the inverse of {@link formatAmount}: a formatted balance
 * parses back to itself). A leading `-` is accepted so signed figures round-trip; operations refuse
 * non-positive amounts themselves.
 *
 * ```ts
 * const usdc = await wallet.asset("USDC");
 * await wallet.transfer({ asset: usdc.id, amount: parseAmount("12.5", usdc), recipient });
 * ```
 *
 * @throws {InvalidArgumentError} on a non-string, a malformed number, an asset without decimals, or
 * an off-unit amount under `"exact"`.
 */
export function parseAmount(
    value: string,
    asset: AssetUnits,
    opts: { round?: Rounding | undefined } = {},
): CircuitAmount {
    if (typeof value !== "string") {
        throw new InvalidArgumentError(
            `parseAmount: value must be a decimal string, got ${typeof value}` +
                (typeof value === "number"
                    ? ` (${value} cannot be represented exactly in binary floating point; pass "${value}")`
                    : ""),
            { argument: "amount" },
        );
    }
    const decimals = assertDecimals(asset, "parseAmount");
    const { scale, index } = assertUnits(asset, "parseAmount");
    const round = roundingOf(opts.round, defaultRounding(asset));
    const text = value.trim();
    const m = DECIMAL.exec(text);
    if (!m) {
        throw new InvalidArgumentError(`parseAmount: "${text}" is not a decimal number`, {
            argument: "amount",
        });
    }
    const [, sign, whole = "0", frac = ""] = m;
    const digits = BigInt(whole + frac);
    // circuit = digits * 10^decimals * RAY / (10^frac * scale * index), one division.
    const numer = digits * 10n ** BigInt(decimals) * RAY;
    const denom = 10n ** BigInt(frac.length) * scale * index;
    const units = divide(
        sign ? -numer : numer,
        denom,
        round,
        () =>
            `parseAmount: "${text}" is not a whole number of circuit units of this asset ` +
            `(scale ${scale}${index === RAY ? "" : `, index ${index}`}); pass { round: "down" } ` +
            `or { round: "up" }, or use \`minAmount\` for the smallest step`,
        "amount",
    );
    return branded<CircuitAmount>(units);
}

/**
 * Circuit units → human decimal string, trailing zeros dropped. Signed amounts keep their sign.
 *
 * `round` (default `"down"`) applies where a unit is not a whole number of base units (a yield
 * asset) and where `maxDecimals` cuts digits. `symbol: true` appends the asset's `symbol` when it
 * carries one.
 *
 * ```ts
 * formatAmount(balance.total, balance.asset, { symbol: true }); // "0.25 WETH"
 * ```
 */
export function formatAmount(
    amount: CircuitAmount | bigint,
    asset: AssetUnits,
    opts: {
        symbol?: boolean | undefined;
        round?: "down" | "up" | undefined;
        maxDecimals?: number | undefined;
    } = {},
): string {
    if (typeof amount !== "bigint") {
        throw new InvalidArgumentError(
            `formatAmount: amount must be a bigint, got ${typeof amount}`,
            { argument: "amount" },
        );
    }
    const decimals = assertDecimals(asset, "formatAmount");
    const round = opts.round ?? "down";
    let base = toBaseUnits(amount, asset, { round });
    if (opts.maxDecimals !== undefined) {
        if (!Number.isInteger(opts.maxDecimals) || opts.maxDecimals < 0) {
            throw new InvalidArgumentError(
                `formatAmount: maxDecimals must be a non-negative integer, got ${opts.maxDecimals}`,
                { argument: "maxDecimals" },
            );
        }
        // Rounded to whole steps, so the cut digits are zeros that `formatUnits` drops.
        if (opts.maxDecimals < decimals) {
            const step = 10n ** BigInt(decimals - opts.maxDecimals);
            base = branded<TokenAmount>(divide(base, step, round, () => "", "amount") * step);
        }
    }
    const text = formatUnits(base, decimals);
    const symbol = (asset as { symbol?: unknown }).symbol;
    return opts.symbol && typeof symbol === "string" && symbol ? `${text} ${symbol}` : text;
}

/**
 * Circuit units → ERC-20 base units at the asset's display index. Default `round: "down"`.
 *
 * For a payment on a yield asset, size the pull from the pool's rate (`depositTotals`), not this.
 */
export function toBaseUnits(
    amount: CircuitAmount | bigint,
    asset: AssetUnits,
    opts: { round?: "down" | "up" | undefined } = {},
): TokenAmount {
    const { scale, index } = assertUnits(asset, "toBaseUnits");
    const round = opts.round ?? "down";
    return branded<TokenAmount>(divide(amount * scale * index, RAY, round, () => "", "amount"));
}

/**
 * ERC-20 base units → circuit units. Default `round`: `"exact"` for a plain asset, `"up"` for a
 * yield asset, as for an `Amount`.
 *
 * @throws {InvalidArgumentError} for an off-unit amount under `"exact"`.
 */
export function fromBaseUnits(
    base: TokenAmount | bigint,
    asset: AssetUnits,
    opts: { round?: Rounding | undefined } = {},
): CircuitAmount {
    if (typeof base !== "bigint") {
        throw new InvalidArgumentError(
            `fromBaseUnits: base units must be a bigint, got ${typeof base}`,
            { argument: "baseUnits" },
        );
    }
    const { scale, index } = assertUnits(asset, "fromBaseUnits");
    const round = roundingOf(opts.round, defaultRounding(asset));
    return branded<CircuitAmount>(
        divide(
            base * RAY,
            scale * index,
            round,
            () =>
                `fromBaseUnits: ${base} base units is not a whole number of circuit units ` +
                `(scale ${scale}${index === RAY ? "" : `, index ${index}`}); pass a rounding`,
            "baseUnits",
        ),
    );
}

/**
 * Resolve a caller's {@link Amount} to circuit units. Positivity is not checked here; see
 * {@link requirePositive}.
 *
 * @throws {InvalidArgumentError} for a `number` or any other shape.
 */
export function resolveAmount(
    amount: Amount,
    asset: AssetUnits,
    argument = "amount",
): CircuitAmount {
    if (typeof amount === "string") {
        return rethrowAs(argument, () => parseAmount(amount, asset));
    }
    if (typeof amount === "bigint") return circuitAmount(amount);
    if (typeof amount === "object" && amount !== null && "baseUnits" in amount) {
        const { baseUnits, round } = amount;
        if (typeof baseUnits !== "bigint") {
            throw new InvalidArgumentError(`${argument}.baseUnits must be a bigint`, { argument });
        }
        return rethrowAs(argument, () => fromBaseUnits(baseUnits, asset, { round }));
    }
    throw new InvalidArgumentError(
        `${argument} must be a decimal string, circuitAmount(x) or { baseUnits }, got ` +
            (typeof amount === "number"
                ? `the number ${amount}, which cannot be represented exactly; pass "${amount}"`
                : typeof amount),
        { argument },
    );
}

function rethrowAs<T>(argument: string, fn: () => T): T {
    try {
        return fn();
    } catch (err) {
        if (err instanceof InvalidArgumentError && err.argument !== argument) {
            throw new InvalidArgumentError(err.message, { argument, cause: err });
        }
        throw err;
    }
}

/**
 * Refuse an amount that no asset could make positive, before the asset is resolved: a `number`, a
 * non-positive bigint or `baseUnits`, a malformed or non-positive decimal string. What depends on
 * the asset (an off-unit string, rounding to zero) is checked after resolution.
 */
export function precheckAmount(amount: unknown, argument = "amount", op?: string): void {
    const prefix = op ? `${op}: ` : "";
    if (typeof amount === "string") {
        const m = DECIMAL.exec(amount.trim());
        if (!m) {
            throw new InvalidArgumentError(
                `${prefix}${argument} "${amount}" is not a decimal number`,
                {
                    argument,
                },
            );
        }
        if (m[1] || /^0*$/.test((m[2] ?? "") + (m[3] ?? ""))) {
            throw new InvalidArgumentError(
                `${prefix}${argument} must be positive, got "${amount}"`,
                {
                    argument,
                },
            );
        }
        return;
    }
    if (typeof amount === "bigint") {
        requirePositive(amount, argument, op);
        return;
    }
    if (typeof amount === "object" && amount !== null && "baseUnits" in amount) {
        const base = (amount as { baseUnits: unknown }).baseUnits;
        if (typeof base !== "bigint") {
            throw new InvalidArgumentError(`${prefix}${argument}.baseUnits must be a bigint`, {
                argument,
            });
        }
        requirePositive(base, argument, op);
        return;
    }
    // Anything else, `number` included, is refused with the full explanation.
    resolveAmount(amount as Amount, { scale: 1n }, argument);
}

/** Refuse a zero or negative amount before any I/O. */
export function requirePositive(value: bigint, argument = "amount", op?: string): void {
    if (value <= 0n) {
        throw new InvalidArgumentError(
            `${op ? `${op}: ` : ""}${argument} must be positive, got ${value}`,
            { argument },
        );
    }
}

/** An {@link OutAmount} resolved against its asset. */
export interface ResolvedOutAmount {
    side: OutAmountSide;
    /** `publicOut`, circuit units. */
    gross: CircuitAmount;
    /** Base units delivered after the protocol fee: `withdrawNet(gross).net`. */
    net: TokenAmount;
    /** Base units the protocol keeps. */
    fee: TokenAmount;
}

/**
 * The side an {@link OutAmount} names.
 *
 * @throws {InvalidArgumentError} (`argument: "gross"`) when both or neither side is given.
 */
export function requireOutSide(out: unknown, op?: string): OutAmountSide {
    const o = (out ?? {}) as { gross?: unknown; net?: unknown };
    const hasGross = o.gross !== undefined;
    if (hasGross === (o.net !== undefined)) {
        throw new InvalidArgumentError(
            `${op ? `${op}: ` : ""}pass exactly one of \`gross\` or \`net\``,
            { argument: "gross" },
        );
    }
    return hasGross ? "gross" : "net";
}

/** The withdraw-fee terms of `asset`, as `withdrawNet` and `grossForNet` take them. */
export function withdrawTerms(
    asset: Pick<AssetInfo, "scale" | "index" | "withdrawBps" | "yieldEnabled">,
) {
    return {
        feeBps: asset.withdrawBps,
        scale: asset.scale,
        index: asset.index,
        yieldEnabled: asset.yieldEnabled,
    };
}

/**
 * Resolve exactly one of `gross` / `net` to the `publicOut` that leaves the pool.
 *
 * - `gross`: the amount itself.
 * - `net`: target base units (`baseUnits` as given, else the resolved units at the display index),
 *   grossed up with {@link grossForNet} to the smallest `publicOut` delivering at least that.
 *   Never snapped to a denomination.
 *
 * @throws {InvalidArgumentError} when both or neither side is given, or the amount is not positive.
 */
export function resolveOutAmount(
    out: OutAmount,
    asset: Pick<AssetInfo, "scale" | "index" | "decimals" | "withdrawBps" | "yieldEnabled">,
    op?: string,
): ResolvedOutAmount {
    const side = requireOutSide(out, op);
    const o = out as { gross?: Amount; net?: Amount };
    let gross: CircuitAmount;
    if (side === "gross") {
        gross = resolveAmount(o.gross as Amount, asset, "gross");
        requirePositive(gross, "gross", op);
    } else {
        const amount = o.net as Amount;
        let target: bigint;
        if (typeof amount === "object" && amount !== null && "baseUnits" in amount) {
            // The target is the exact base units; they are never converted to units.
            if (typeof amount.baseUnits !== "bigint") {
                throw new InvalidArgumentError("net.baseUnits must be a bigint", {
                    argument: "net",
                });
            }
            roundingOf(amount.round, "exact");
            target = amount.baseUnits;
        } else {
            target = toBaseUnits(resolveAmount(amount, asset, "net"), asset);
        }
        requirePositive(target, "net", op);
        gross = branded<CircuitAmount>(grossForNet({ net: target, ...withdrawTerms(asset) }));
    }
    const split = withdrawNet({ publicOut: gross, ...withdrawTerms(asset) });
    return {
        side,
        gross,
        net: branded<TokenAmount>(split.net),
        fee: branded<TokenAmount>(split.fee),
    };
}

// --- Money ---------------------------------------------------------------------------------------

/**
 * A shielded figure (note value, `publicIn` / `publicOut`, a unit-denominated fee): `amount` is
 * exact and `baseUnits` its conversion, floored.
 */
export function shieldedMoney(
    asset: Pick<AssetInfo, "id" | "scale" | "index">,
    amount: CircuitAmount | bigint,
): Money {
    return Object.freeze({
        asset: asset.id,
        amount: branded<CircuitAmount>(amount),
        baseUnits: toBaseUnits(amount, asset, { round: "down" }),
    });
}

/**
 * A public figure (a pull, a refund, what a recipient received, a plain-asset protocol fee):
 * `baseUnits` is exact and `amount` is `fromBaseUnits(baseUnits, { round: "down" })`, for display.
 */
export function publicMoney(
    asset: Pick<AssetInfo, "id" | "scale" | "index">,
    baseUnits: TokenAmount | bigint,
): Money {
    return Object.freeze({
        asset: asset.id,
        amount: fromBaseUnits(baseUnits, asset, { round: "down" }),
        baseUnits: branded<TokenAmount>(baseUnits),
    });
}

/** `null` for a zero figure: a fee that was not charged is never a zero `Money`. */
export function chargedMoney(money: Money): Money | null {
    return money.amount === 0n && money.baseUnits === 0n ? null : money;
}

// --- the amount contract: how a caller states an amount and names an asset ----------------------
//
// Three amount spaces exist (human string, circuit units, ERC-20 base units). An `Amount` names
// which one it is by its runtime shape, never by magnitude:
//
//   "12.5"                        human decimal string of the asset's token
//   circuitAmount(12_500_000n)    circuit units (branded; a plain `bigint` does not compile)
//   { baseUnits: 12_500_000n }    ERC-20 base units
//
// `number` does not compile, and is refused at runtime with `INVALID_ARGUMENT` for JS callers.

export type { AssetRef } from "./asset-ref.js";

/**
 * Rounding applied when an amount does not land on a whole circuit unit.
 *
 * - `"exact"` refuses with `INVALID_ARGUMENT`.
 * - `"down"` floors: the caller moves at most what they named.
 * - `"up"` ceils: the smallest unit count worth at least what they named.
 */
export type Rounding = "exact" | "down" | "up";

/**
 * An amount of one asset, in whichever space the caller holds it.
 *
 * A plain `bigint` is deliberately not accepted: `100n` could be circuit units or base units, which
 * differ by `scale` (up to 10^12). Brand it with `circuitAmount(x)`, pass `{ baseUnits: x }`, or pass
 * a value the SDK returned.
 *
 * Off-unit strings and base units round by the asset's default: `"exact"` for a plain asset,
 * `"up"` for a yield asset (the inverse of `formatAmount`, so a formatted balance parses back to
 * itself and never over-draws). `{ baseUnits, round }` overrides it; for a string, call
 * `parseAmount(value, asset, { round })` first.
 */
export type Amount =
    | string
    | CircuitAmount
    | {
          baseUnits: TokenAmount | bigint;
          round?: Rounding | undefined;
      };

/**
 * Which side of the protocol fee an outbound amount names. Exactly one of the two.
 *
 * - `gross`: the `publicOut` leaving the pool, published on-chain; the protocol fee comes out of it.
 * - `net`: what reaches the recipient (withdraw) or the venue (swap), `gross − protocol fee`. The
 *   SDK grosses it up to the smallest `publicOut` whose net covers it; results then report
 *   `onLadder`, since that `publicOut` is rarely a denomination.
 *
 * The relayer's fee is never inside either figure; it is always `fees.relayer`.
 */
export type OutAmount =
    | { gross: Amount; net?: never }
    | {
          net: Amount;
          gross?: never;
      };

/** Which side an {@link OutAmount} names. */
export type OutAmountSide = "gross" | "net";

/**
 * The fields amount conversion reads. `AssetInfo` satisfies it, so SDK-returned assets pass as-is;
 * an app's own registry row with these three fields does too.
 */
export interface AssetUnits {
    /**
     * ERC-20 decimals. Optional so an `AssetInfo` whose token reported none still satisfies this
     * type; `parseAmount` / `formatAmount` then reject `INVALID_ARGUMENT`, while `toBaseUnits` /
     * `fromBaseUnits` do not read it.
     */
    decimals?: number | undefined;
    /** Circuit units → base units multiplier. */
    scale: bigint;
    /** Yield index, RAY-scaled. Absent or `RAY` for a plain asset. */
    index?: bigint | undefined;
}

/**
 * Build an {@link OutAmount} from a side chosen at runtime (a gross/net toggle).
 *
 * `{ [side]: amount }` widens to an index signature and does not type-check as `OutAmount`; this
 * keeps the exclusivity.
 */
export function outAmount(side: OutAmountSide, amount: Amount): OutAmount {
    return side === "gross" ? { gross: amount } : { net: amount };
}

/** The side an {@link OutAmount} names, and its amount. */
export function outAmountSide(out: OutAmount): { side: OutAmountSide; amount: Amount } {
    return out.gross !== undefined
        ? { side: "gross", amount: out.gross }
        : { side: "net", amount: out.net as Amount };
}
