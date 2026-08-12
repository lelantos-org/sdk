import { describe, expect, it } from "vitest";
import { circuitAmount, tokenAmount } from "./brand.js";
import { formatUnits, parseUnits, toCircuitUnits, toTokenUnits } from "./units.js";

describe("parseUnits", () => {
    it("scales a decimal string by `decimals`", () => {
        expect(parseUnits("1.5", 18)).toBe(1_500_000_000_000_000_000n);
        expect(parseUnits("1", 6)).toBe(1_000_000n);
        expect(parseUnits("0.000001", 6)).toBe(1n);
        expect(parseUnits("0", 18)).toBe(0n);
    });

    it("round-trips through formatUnits", () => {
        for (const v of ["0", "1", "1.5", "0.000000000000000001", "123456.789"]) {
            expect(formatUnits(parseUnits(v, 18), 18)).toBe(v === "0" ? "0" : v);
        }
    });

    it("accepts numbers and bigints", () => {
        expect(parseUnits(2, 6)).toBe(2_000_000n);
        expect(parseUnits(3n, 6)).toBe(3_000_000n);
    });

    it("handles negatives", () => {
        expect(parseUnits("-1.5", 18)).toBe(-1_500_000_000_000_000_000n);
        expect(formatUnits(-1_500_000_000_000_000_000n, 18)).toBe("-1.5");
    });

    it("rejects more precision than `decimals` can hold", () => {
        expect(() => parseUnits("0.0000001", 6)).toThrow(/only 6 are representable/);
    });

    it("rejects junk and exponent notation", () => {
        expect(() => parseUnits("abc", 18)).toThrow(/not a decimal number/);
        expect(() => parseUnits("1e-7", 18)).toThrow(/not a decimal number/);
        expect(() => parseUnits(1e-7, 18)).toThrow(/exponent notation/);
        expect(() => parseUnits(Number.NaN, 18)).toThrow(/not finite/);
    });
});

describe("formatUnits", () => {
    it("drops trailing fractional zeros", () => {
        expect(formatUnits(1_500_000_000_000_000_000n, 18)).toBe("1.5");
        expect(formatUnits(1_000_000_000_000_000_000n, 18)).toBe("1");
        expect(formatUnits(1n, 18)).toBe("0.000000000000000001");
        expect(formatUnits(0n, 18)).toBe("0");
    });
});

describe("circuit units", () => {
    it("multiplies and divides by scale", () => {
        expect(toTokenUnits(circuitAmount(1500n), 10n ** 15n)).toBe(1_500_000_000_000_000_000n);
        expect(toCircuitUnits(tokenAmount(1_500_000_000_000_000_000n), 10n ** 15n)).toBe(1500n);
    });

    it("refuses to silently drop dust", () => {
        expect(() => toCircuitUnits(tokenAmount(1_500_000_000_000_000_001n), 10n ** 15n)).toThrow(
            /not a multiple of scale/,
        );
        expect(
            toCircuitUnits(tokenAmount(1_500_000_000_000_000_001n), 10n ** 15n, { round: "down" }),
        ).toBe(1500n);
    });

    it("rejects a non-positive scale", () => {
        expect(() => toCircuitUnits(tokenAmount(1n), 0n)).toThrow(/scale must be positive/);
    });
});
