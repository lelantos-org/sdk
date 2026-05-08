import { describe, expect, it } from "vitest";
import { BN254_FR, FMD_LEGENDRE_QNR } from "./tags.js";
import { fmdLegendreWitness, legendreSymbol, modInverse, modSqrt } from "./sqrt.js";

function mod(a: bigint, p: bigint): bigint {
    const r = a % p;
    return r < 0n ? r + p : r;
}

describe("modular sqrt + Legendre", () => {
    it("FMD_LEGENDRE_QNR is actually a QNR", () => {
        expect(legendreSymbol(FMD_LEGENDRE_QNR, BN254_FR)).toBe(-1);
    });

    it("modSqrt round-trips on random QRs", () => {
        for (const seed of [1n, 2n, 7n, 12345n, 1n << 100n]) {
            const sq = mod(seed * seed, BN254_FR);
            const root = modSqrt(sq, BN254_FR);
            expect(root).not.toBeNull();
            expect(mod(root! * root!, BN254_FR)).toBe(sq);
        }
    });

    it("modSqrt returns null on non-residues", () => {
        for (const seed of [3n, 11n, 0xc0den]) {
            const qnr = mod(FMD_LEGENDRE_QNR * seed * seed, BN254_FR);
            expect(legendreSymbol(qnr, BN254_FR)).toBe(-1);
            expect(modSqrt(qnr, BN254_FR)).toBeNull();
        }
    });

    it("legendreSymbol returns 0 on zero", () => {
        expect(legendreSymbol(0n, BN254_FR)).toBe(0);
    });

    it("fmdLegendreWitness produces a valid (bit, y) for QR inputs", () => {
        const h = mod(13n * 13n, BN254_FR);
        const w = fmdLegendreWitness(h);
        expect(w.bit).toBe(1);
        // hash === y² · 1
        expect(mod(w.y * w.y, BN254_FR)).toBe(h);
    });

    it("fmdLegendreWitness produces a valid (bit, y) for QNR inputs", () => {
        const h = mod(FMD_LEGENDRE_QNR * 19n * 19n, BN254_FR);
        const w = fmdLegendreWitness(h);
        expect(w.bit).toBe(0);
        // hash === y² · Z
        expect(mod(w.y * w.y * FMD_LEGENDRE_QNR, BN254_FR)).toBe(h);
    });

    it("fmdLegendreWitness is uniform-ish over many inputs", () => {
        const N = 200;
        let qrCount = 0;
        let s = 1n;
        for (let i = 0; i < N; i++) {
            s = mod(s * 6364136223846793005n + 1442695040888963407n, BN254_FR);
            if (s === 0n) continue;
            qrCount += fmdLegendreWitness(s).bit;
        }
        // 200 fair coins: P[<70 or >130] ≈ 4·10^-9. Loose bound.
        expect(qrCount).toBeGreaterThan(70);
        expect(qrCount).toBeLessThan(130);
    });

    it("modInverse sanity", () => {
        const x = 12345n;
        const xinv = modInverse(x, BN254_FR);
        expect(mod(x * xinv, BN254_FR)).toBe(1n);
    });
});
