import { beforeAll, describe, expect, it } from "vitest";
import { BABYJUB_SUBGROUP_ORDER, Jubjub, Poseidon } from "./crypto/index.js";
import {
    decodeClue,
    encodeClue,
    FMD_DEFAULT_GAMMA,
    fmdFlag,
    fmdFlagKeyFromDetection,
    fmdTest,
} from "./fmd.js";

describe("FMD (Niwl)", () => {
    let J: Jubjub;
    let P: Poseidon;
    beforeAll(async () => {
        J = await Jubjub.build();
        P = await Poseidon.build();
    });

    function rng(seed: bigint) {
        let s = seed;
        return () => {
            s = (s * 6364136223846793005n + 1442695040888963407n) & ((1n << 128n) - 1n);
            return s % BABYJUB_SUBGROUP_ORDER;
        };
    }

    it("self-detection always succeeds", () => {
        const r = rng(1n);
        const dk = { x: [r(), r(), r(), r(), r()] };
        const fk = fmdFlagKeyFromDetection(J, dk);
        for (let trial = 0; trial < 16; trial++) {
            const clue = fmdFlag(J, P, fk, r());
            expect(fmdTest(J, P, dk, clue)).toBe(true);
        }
    });

    it("foreign detection statistically near 2^-γ", () => {
        const N = 256;
        const γ = FMD_DEFAULT_GAMMA;
        const ra = rng(0xa1n),
            rb = rng(0xb2n);
        const dkA = { x: Array.from({ length: γ }, () => ra()) };
        const dkB = { x: Array.from({ length: γ }, () => rb()) };
        const fkA = fmdFlagKeyFromDetection(J, dkA);
        let hits = 0;
        for (let i = 0; i < N; i++) {
            const clue = fmdFlag(J, P, fkA, ra());
            if (fmdTest(J, P, dkB, clue)) hits++;
        }
        // E[hits] = N · 2^-γ = 256/32 = 8. Tolerate up to 4× expectation.
        expect(hits).toBeLessThan(N / 2);
    });

    it("encode / decode round-trip", () => {
        const r = rng(42n);
        const dk = { x: [r(), r(), r()] };
        const fk = fmdFlagKeyFromDetection(J, dk);
        const clue = fmdFlag(J, P, fk, r());
        const enc = encodeClue(clue);
        const dec = decodeClue(enc);
        expect(dec.gamma).toBe(clue.gamma);
        expect(Array.from(dec.R)).toEqual(Array.from(clue.R));
        expect(Array.from(dec.bits)).toEqual(Array.from(clue.bits));
        expect(fmdTest(J, P, dk, dec)).toBe(true);
    });
});
