import { describe, expect, it } from "vitest";
import { BN254_FR, FMD_LEGENDRE_QNR } from "../core/field.js";
import { InvalidArgumentError } from "../errors/config.js";
import { fmdLegendreWitness, jacobiSymbol, legendreSymbol, modInverse, modSqrt } from "./sqrt.js";

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
        // 200 fair coins: P[<70 or >130] ≈ 4·10^-9.
        expect(qrCount).toBeGreaterThan(70);
        expect(qrCount).toBeLessThan(130);
    });

    it("modInverse sanity", () => {
        const x = 12345n;
        const xinv = modInverse(x, BN254_FR);
        expect(mod(x * xinv, BN254_FR)).toBe(1n);
    });
});

// `jacobiSymbol` serves the FMD clue bit; `legendreSymbol`, Euler's criterion, is its reference.
describe("jacobiSymbol", () => {
    const p = BN254_FR;

    /** A 128-bit LCG; `wide()` joins four draws into 512 bits. */
    function lcg(seed: bigint): () => bigint {
        let s = seed;
        return () => {
            s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 128n) - 1n);
            return s;
        };
    }
    const wide = (next: () => bigint) =>
        (next() << 384n) | (next() << 256n) | (next() << 128n) | next();

    it("equals legendreSymbol over BN254_FR at the edges of the field", () => {
        const edges = [0n, 1n, 2n, 3n, 4n, p - 2n, p - 1n, (p - 1n) / 2n, (p + 1n) / 2n];
        // Even elements down to the 2-adicity of p - 1 and past it: the factor-of-two branch.
        for (const shift of [1n, 2n, 27n, 28n, 29n, 64n, 200n, 253n]) edges.push(1n << shift);
        for (const a of edges) {
            expect(jacobiSymbol(a, p), `a = ${a}`).toBe(legendreSymbol(a, p));
        }
        expect(jacobiSymbol(0n, p)).toBe(0);
        expect(jacobiSymbol(1n, p)).toBe(1);
        // p ≡ 1 (mod 4): -1 is a square.
        expect(jacobiSymbol(p - 1n, p)).toBe(1);
    });

    it("equals legendreSymbol on unreduced and negative inputs", () => {
        const next = lcg(0xa11ce5n);
        const inputs = [p, p + 1n, p + 5n, 2n * p, 2n * p - 1n, -1n, -5n, -p, -p - 5n, 1n << 300n];
        for (let i = 0; i < 200; i++) inputs.push(wide(next), -wide(next));
        for (const a of inputs) {
            expect(jacobiSymbol(a, p), `a = ${a}`).toBe(legendreSymbol(a, p));
        }
    });

    it("equals legendreSymbol on random field elements", () => {
        const next = lcg(0x5eedn);
        let residues = 0;
        const N = 2000;
        for (let i = 0; i < N; i++) {
            const a = wide(next) % p;
            const sym = jacobiSymbol(a, p);
            expect(sym, `a = ${a}`).toBe(legendreSymbol(a, p));
            if (sym === 1) residues++;
        }
        // 2000 fair coins: outside [850, 1150] has probability below 10^-10.
        expect(residues).toBeGreaterThan(850);
        expect(residues).toBeLessThan(1150);
    });

    it("is 1 on squares and -1 on the non-residue times a square", () => {
        const next = lcg(0xc0ffeen);
        expect(jacobiSymbol(FMD_LEGENDRE_QNR, p)).toBe(-1);
        for (let i = 0; i < 300; i++) {
            const s = (wide(next) % (p - 1n)) + 1n;
            const square = mod(s * s, p);
            expect(jacobiSymbol(square, p)).toBe(1);
            expect(jacobiSymbol(mod(FMD_LEGENDRE_QNR * square, p), p)).toBe(-1);
        }
    });

    it("equals legendreSymbol for every residue of small primes", () => {
        for (const prime of [3n, 5n, 7n, 11n, 13n, 17n, 97n, 251n, 257n, 65537n]) {
            const step = prime > 1000n ? 37n : 1n;
            for (let a = -prime; a <= 2n * prime; a += step) {
                expect(jacobiSymbol(a, prime), `(${a} / ${prime})`).toBe(legendreSymbol(a, prime));
            }
        }
    });

    it("is multiplicative in both arguments over composite moduli", () => {
        const next = lcg(0xfaceb00cn);
        const odd = () => (wide(next) % (1n << 200n)) | 1n;
        // `|| 0` turns the `-0` of `0 * -1` into `0`.
        const product = (x: number, y: number) => x * y || 0;
        for (let i = 0; i < 200; i++) {
            const [a, b, m, n] = [wide(next), wide(next), odd(), odd()];
            expect(jacobiSymbol(a * b, n)).toBe(product(jacobiSymbol(a, n), jacobiSymbol(b, n)));
            expect(jacobiSymbol(a, m * n)).toBe(product(jacobiSymbol(a, m), jacobiSymbol(a, n)));
        }
        expect(jacobiSymbol(5n, 1n)).toBe(1);
        expect(jacobiSymbol(0n, 1n)).toBe(1);
        // A common factor gives zero: gcd(21, 15) = 3.
        expect(jacobiSymbol(21n, 15n)).toBe(0);
        // (2 / 15) = 1 although 2 is not a square mod 15.
        expect(jacobiSymbol(2n, 15n)).toBe(1);
    });

    it("rejects an even or non-positive modulus", () => {
        for (const n of [0n, -1n, -7n, 2n, 4n, p - 1n]) {
            expect(() => jacobiSymbol(3n, n)).toThrow(InvalidArgumentError);
        }
    });
});
