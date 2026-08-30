import { describe, expect, it } from "vitest";
import { circuitAmount, tokenAmount } from "./brand.js";
import { formatUnits, parseUnits, RAY, toCircuitUnits, toTokenUnits } from "./units.js";

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

describe("index-aware conversions", () => {
    it("is the identity at RAY, so a pre-yield caller sees no change", () => {
        expect(toTokenUnits(circuitAmount(1_500n), 10n ** 15n)).toBe(1_500_000_000_000_000_000n);
        expect(toTokenUnits(circuitAmount(1_500n), 10n ** 15n, { index: RAY })).toBe(
            1_500_000_000_000_000_000n,
        );
        expect(toCircuitUnits(tokenAmount(1_500_000_000_000_000_000n), 10n ** 15n)).toBe(1_500n);
    });

    it("grows the token value of a fixed circuit amount as the index grows", () => {
        // The note is never rewritten; only what it is worth moves.
        const n = circuitAmount(1_000_000_000n);
        expect(toTokenUnits(n, 1n, { index: (RAY * 105n) / 100n })).toBe(1_050_000_000n);
        expect(toTokenUnits(n, 1n, { index: RAY * 2n })).toBe(2_000_000_000n);
    });

    it("rounds down out of the pool and up into it, so dust favours holders", () => {
        // 3 * 1 * (RAY/3 * 1) is deliberately inexact.
        const idx = RAY / 3n; // 0.333… — a third
        const n = circuitAmount(10n);
        const down = toTokenUnits(n, 1n, { index: idx });
        const up = toTokenUnits(n, 1n, { index: idx, round: "up" });
        expect(up - down).toBe(1n);
        expect(down).toBeLessThan(up);
    });

    it("does not round up a value that is already exact", () => {
        expect(toTokenUnits(circuitAmount(10n), 1n, { index: RAY, round: "up" })).toBe(10n);
    });

    it("round-trips a circuit amount through a non-unity index", () => {
        const idx = (RAY * 105n) / 100n;
        const n = circuitAmount(1_000_000_000n);
        const tokens = toTokenUnits(n, 1n, { index: idx });
        expect(toCircuitUnits(tokenAmount(tokens), 1n, { index: idx })).toBe(n);
    });

    it("rejects a non-positive index rather than dividing by zero", () => {
        expect(() => toTokenUnits(circuitAmount(1n), 1n, { index: 0n })).toThrow(RangeError);
        expect(() => toCircuitUnits(tokenAmount(1n), 1n, { index: -1n })).toThrow(RangeError);
    });

    it("names the index in the inexact error only once it is moving", () => {
        const idx = (RAY * 105n) / 100n;
        expect(() => toCircuitUnits(tokenAmount(7n), 10n, {})).toThrow(/multiple of scale/);
        expect(() => toCircuitUnits(tokenAmount(7n), 10n, { index: idx })).toThrow(/index/);
    });
});
