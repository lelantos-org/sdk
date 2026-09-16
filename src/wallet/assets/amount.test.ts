// The amount contract: one rounding per conversion, a round trip through the
// human string, and `Money` built from whichever side is exact.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assetId, circuitAmount, tokenAmount } from "../../core/brand.js";
import { isWalletError } from "../../errors/guard.js";
import { withdrawNet } from "../../protocol/fees.js";
import { RAY } from "../../protocol/units.js";
import type { AssetUnits } from "./amount.js";
import {
    chargedMoney,
    formatAmount,
    fromBaseUnits,
    outAmount,
    outAmountSide,
    parseAmount,
    publicMoney,
    requirePositive,
    resolveAmount,
    resolveOutAmount,
    shieldedMoney,
    toBaseUnits,
} from "./amount.js";

function code(fn: () => unknown): string | undefined {
    try {
        fn();
    } catch (err) {
        return isWalletError(err) ? err.code : "NOT_A_WALLET_ERROR";
    }
    return undefined;
}

const usdc: AssetUnits = { decimals: 6, scale: 1_000n };
const weth: AssetUnits = { decimals: 18, scale: 10n ** 15n };
const yieldUsdc: AssetUnits = { decimals: 6, scale: 1_000n, index: (RAY * 1_0371n) / 1_0000n };

/** Units of an asset whose unit is worth at least one base unit, the precondition of the round trip. */
const plainAsset = fc
    .record({ decimals: fc.integer({ min: 0, max: 24 }), exp: fc.integer({ min: 0, max: 18 }) })
    .filter(({ decimals, exp }) => exp <= decimals)
    .map(({ decimals, exp }): AssetUnits => ({ decimals, scale: 10n ** BigInt(exp) }));

const yieldAsset = fc
    .record({
        decimals: fc.integer({ min: 0, max: 24 }),
        exp: fc.integer({ min: 0, max: 18 }),
        index: fc.bigInt({ min: RAY + 1n, max: 5n * RAY }),
    })
    .filter(({ decimals, exp }) => exp <= decimals)
    .map(
        ({ decimals, exp, index }): AssetUnits => ({ decimals, scale: 10n ** BigInt(exp), index }),
    );

const units = fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n });

describe("parseAmount ∘ formatAmount", () => {
    it("round-trips every amount of a plain asset", () => {
        fc.assert(
            fc.property(plainAsset, units, (asset, x) => {
                expect(parseAmount(formatAmount(x, asset), asset)).toBe(x);
            }),
            { numRuns: 1000 },
        );
    });

    it("round-trips every amount of a yield asset", () => {
        fc.assert(
            fc.property(yieldAsset, units, (asset, x) => {
                expect(parseAmount(formatAmount(x, asset), asset)).toBe(x);
            }),
            { numRuns: 1000 },
        );
    });

    it("round-trips through base units with the default rounding", () => {
        fc.assert(
            fc.property(fc.oneof(plainAsset, yieldAsset), units, (asset, x) => {
                expect(fromBaseUnits(toBaseUnits(x, asset), asset)).toBe(x);
            }),
            { numRuns: 1000 },
        );
    });
});

describe("parseAmount", () => {
    it("parses a plain asset exactly", () => {
        expect(parseAmount("12.5", usdc)).toBe(12_500n);
        expect(parseAmount("0.25", weth)).toBe(250n);
        expect(parseAmount(" 1 ", usdc)).toBe(1_000n);
        expect(parseAmount("-1.5", usdc)).toBe(-1_500n);
    });

    it("refuses an off-unit plain amount unless told how to round", () => {
        expect(code(() => parseAmount("0.0001", usdc))).toBe("INVALID_ARGUMENT");
        expect(parseAmount("0.0001", usdc, { round: "down" })).toBe(0n);
        expect(parseAmount("0.0001", usdc, { round: "up" })).toBe(1n);
        // More digits than the token has are still one rational division.
        expect(parseAmount("1.0000001", usdc, { round: "up" })).toBe(1_001n);
    });

    it("rounds a yield asset up by default, and down on request", () => {
        const up = parseAmount("1", yieldUsdc);
        const down = parseAmount("1", yieldUsdc, { round: "down" });
        expect(up).toBe(down + 1n);
        expect(code(() => parseAmount("1", yieldUsdc, { round: "exact" }))).toBe(
            "INVALID_ARGUMENT",
        );
    });

    it("refuses a number, a malformed string and an asset without decimals", () => {
        expect(code(() => parseAmount(1.5 as unknown as string, usdc))).toBe("INVALID_ARGUMENT");
        expect(code(() => parseAmount("1e6", usdc))).toBe("INVALID_ARGUMENT");
        expect(code(() => parseAmount("1,5", usdc))).toBe("INVALID_ARGUMENT");
        expect(code(() => parseAmount("1", { scale: 1n }))).toBe("INVALID_ARGUMENT");
    });
});

describe("formatAmount", () => {
    it("drops trailing zeros and keeps the sign", () => {
        expect(formatAmount(12_500n, usdc)).toBe("12.5");
        expect(formatAmount(-12_500n, usdc)).toBe("-12.5");
        expect(formatAmount(0n, usdc)).toBe("0");
    });

    it("appends the symbol when asked and known", () => {
        expect(
            formatAmount(250n, { ...weth, symbol: "WETH" } as AssetUnits, { symbol: true }),
        ).toBe("0.25 WETH");
        expect(formatAmount(250n, weth, { symbol: true })).toBe("0.25");
    });

    it("cuts to maxDecimals in the rounding direction", () => {
        expect(formatAmount(12_345n, usdc, { maxDecimals: 2 })).toBe("12.34");
        expect(formatAmount(12_345n, usdc, { maxDecimals: 2, round: "up" })).toBe("12.35");
        expect(formatAmount(-12_345n, usdc, { maxDecimals: 2, round: "up" })).toBe("-12.35");
        expect(formatAmount(12_345n, usdc, { maxDecimals: 0 })).toBe("12");
    });
});

describe("resolveAmount", () => {
    it("accepts the three forms", () => {
        expect(resolveAmount("1.5", usdc)).toBe(1_500n);
        expect(resolveAmount(circuitAmount(7n), usdc)).toBe(7n);
        expect(resolveAmount({ baseUnits: 7_000n }, usdc)).toBe(7n);
        expect(resolveAmount({ baseUnits: tokenAmount(7_001n), round: "down" }, usdc)).toBe(7n);
    });

    it("applies the asset's default rounding to base units", () => {
        expect(code(() => resolveAmount({ baseUnits: 7_001n }, usdc))).toBe("INVALID_ARGUMENT");
        expect(resolveAmount({ baseUnits: 1n }, yieldUsdc)).toBe(1n);
    });

    it("refuses a number and other shapes as INVALID_ARGUMENT naming the argument", () => {
        for (const bad of [1.5, null, {}, true]) {
            let err: unknown;
            try {
                resolveAmount(bad as never, usdc, "gross");
            } catch (e) {
                err = e;
            }
            expect(isWalletError(err, "INVALID_ARGUMENT")).toBe(true);
            expect(err).toMatchObject({ argument: "gross" });
        }
    });

    it("requirePositive refuses zero and negatives", () => {
        expect(code(() => requirePositive(0n))).toBe("INVALID_ARGUMENT");
        expect(code(() => requirePositive(-1n))).toBe("INVALID_ARGUMENT");
        expect(code(() => requirePositive(1n))).toBeUndefined();
    });
});

describe("resolveOutAmount", () => {
    const asset = {
        id: assetId(2n),
        decimals: 6,
        scale: 1_000n,
        index: RAY,
        withdrawBps: 20n,
        yieldEnabled: false,
    };

    it("takes gross as publicOut", () => {
        const r = resolveOutAmount({ gross: "1000" }, asset);
        expect(r).toMatchObject({ side: "gross", gross: 1_000_000n, net: 998_000_000n });
    });

    it("grosses a net up to the smallest publicOut delivering it", () => {
        const r = resolveOutAmount({ net: "998" }, asset);
        expect(r.side).toBe("net");
        expect(r.gross).toBe(1_000_000n);
        const off = resolveOutAmount({ net: { baseUnits: 998_000_001n } }, asset);
        expect(off.net).toBeGreaterThanOrEqual(998_000_001n);
        expect(
            withdrawNet({ publicOut: off.gross - 1n, feeBps: 20n, scale: 1_000n }).net,
        ).toBeLessThan(998_000_001n);
    });

    it("refuses both, neither, zero and negative", () => {
        expect(code(() => resolveOutAmount({ gross: "1", net: "1" } as never, asset))).toBe(
            "INVALID_ARGUMENT",
        );
        expect(code(() => resolveOutAmount({} as never, asset))).toBe("INVALID_ARGUMENT");
        expect(code(() => resolveOutAmount({ gross: "0" }, asset))).toBe("INVALID_ARGUMENT");
        expect(code(() => resolveOutAmount({ net: "-1" }, asset))).toBe("INVALID_ARGUMENT");
    });

    it("names `gross` whether both sides or neither is given", () => {
        for (const out of [{ gross: "1", net: "1" }, {}]) {
            expect(() => resolveOutAmount(out as never, asset, "withdraw")).toThrow(
                expect.objectContaining({
                    argument: "gross",
                    message: "withdraw: pass exactly one of `gross` or `net`",
                }),
            );
        }
    });
});

describe("Money", () => {
    const asset = { id: assetId(4n), scale: 1_000n, index: (RAY * 3n) / 2n };

    it("keeps a shielded figure's units exact", () => {
        const m = shieldedMoney(asset, 3n);
        expect(m).toEqual({ asset: 4n, amount: 3n, baseUnits: 4_500n });
        expect(Object.isFrozen(m)).toBe(true);
    });

    it("keeps a public figure's base units exact and floors its units", () => {
        expect(publicMoney(asset, 4_501n)).toEqual({ asset: 4n, amount: 3n, baseUnits: 4_501n });
    });

    it("maps a zero figure to null", () => {
        expect(chargedMoney(publicMoney(asset, 0n))).toBeNull();
        expect(chargedMoney(publicMoney(asset, 1n))).not.toBeNull();
    });
});

describe("outAmount", () => {
    it("builds an OutAmount from a runtime side and reads it back", () => {
        expect(outAmount("gross", "1")).toEqual({ gross: "1" });
        expect(outAmount("net", "2")).toEqual({ net: "2" });
        expect(outAmountSide({ net: "2" })).toEqual({ side: "net", amount: "2" });
        expect(outAmountSide({ gross: "1" })).toEqual({ side: "gross", amount: "1" });
    });
});
