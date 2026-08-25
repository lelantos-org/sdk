import { describe, expect, it } from "vitest";
import { InvalidArgumentError } from "../core/errors.js";
import { resolveAmount } from "./amount.js";
import type { AssetInfo } from "./assets.js";

// 6-decimal token at scale 100: one circuit unit is 100 base units, i.e.
// 0.0001 of a token.
const USDC = {
    id: 2n,
    token: "0x",
    scale: 100n,
    disabled: false,
    decimals: 6,
} as unknown as AssetInfo;
const NO_META = { id: 3n, token: "0x", scale: 1n, disabled: false } as unknown as AssetInfo;

describe("resolveAmount", () => {
    /// The split is by type, so the same digits mean different things — and
    /// deliberately so, because guessing from magnitude cannot be made safe.
    it("reads a bigint as circuit units and a string as token units", () => {
        expect(resolveAmount(1250n, USDC)).toBe(1250n);
        expect(resolveAmount("1250", USDC)).toBe(12_500_000n);
    });

    it("resolves a fractional token amount", () => {
        // 12.50 USDC = 12_500_000 base units = 125_000 circuit units at scale 100.
        expect(resolveAmount("12.50", USDC)).toBe(125_000n);
    });

    /// `0.1` is not representable in binary floating point. Rounding someone's
    /// transfer silently is worse than making them quote it.
    it("refuses a number, naming the string to write instead", () => {
        // @ts-expect-error a number is not an AmountLike, and is refused at runtime too.
        expect(() => resolveAmount(0.1, USDC)).toThrow(/Pass "0.1"/);
        // @ts-expect-error same for an integral number.
        expect(() => resolveAmount(5, USDC)).toThrow(InvalidArgumentError);
    });

    /// Dust below one circuit unit cannot be expressed by the pool; truncating
    /// it would quietly under-pay.
    it("refuses an amount finer than one circuit unit", () => {
        expect(() => resolveAmount("0.000001", USDC)).toThrow(RangeError);
    });

    it("refuses a human amount for an asset with no known decimals", () => {
        expect(() => resolveAmount("1.0", NO_META)).toThrow(/no known decimals/);
        // Circuit units stay available: they need no metadata.
        expect(resolveAmount(7n, NO_META)).toBe(7n);
    });
});
