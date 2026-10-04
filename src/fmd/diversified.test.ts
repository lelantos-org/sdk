import { beforeAll, describe, expect, it } from "vitest";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { deriveIvk } from "../crypto/derive.js";
import type { Point } from "../crypto/jubjub.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import { buildDiversifiedKeys, deriveDkRoot } from "../keys/diversified.js";
import { deriveDiversifierKey, diversifierAt, diversifierToField } from "../keys/diversifier.js";
import { lcgScalars } from "../test-utils/lcg.js";
import { fmdFlag, fmdFlagOnBase, fmdTest } from "./clue.js";
import {
    fmdDiversifiedDetectionKey,
    fmdDiversifiedFlagKey,
    fmdExpandScalar2,
    fmdExpectedClue,
} from "./diversified.js";
import { FMD_DEFAULT_GAMMA, type FmdFlagKey, fmdFlagKeyFromDetection } from "./keys.js";

const q = BABYJUB_SUBGROUP_ORDER;

describe("FMD over a diversified base", () => {
    let J: Jubjub;
    let P: Poseidon;
    let ivk: bigint;
    let dkRoot: bigint;
    let ds: bigint[];
    beforeAll(async () => {
        J = await Jubjub.build();
        P = await Poseidon.build();
        ivk = deriveIvk(P, 42n);
        dkRoot = deriveDkRoot(P, ivk);
        const dvk = deriveDiversifierKey(ivk);
        ds = [0, 1, 2, 3, 77, 2 ** 32 - 1].map((index) =>
            diversifierToField(diversifierAt(dvk, index)),
        );
    });

    // What a sender holds for one address: its base and expanded flag key. Cached per address.
    const senderSide = new Map<string, { g_d: Point; fk: FmdFlagKey }>();
    const flagFor = (d: bigint, r: bigint, gamma = FMD_DEFAULT_GAMMA) => {
        const key = `${d}:${gamma}`;
        let address = senderSide.get(key);
        if (!address) {
            const { g_d, ck_d } = buildDiversifiedKeys(P, J, ivk, d);
            address = { g_d, fk: fmdDiversifiedFlagKey(J, P, ck_d, g_d, gamma) };
            senderSide.set(key, address);
        }
        return fmdFlagOnBase(J, P, address.fk, address.g_d, r);
    };

    it("h_i is Poseidon(17, i) mod q", () => {
        for (let i = 0; i < 14; i++) {
            expect(fmdExpandScalar2(P, i)).toBe(P.hash([17n, BigInt(i)]) % q);
        }
        expect(new Set(Array.from({ length: 14 }, (_, i) => fmdExpandScalar2(P, i))).size).toBe(14);
    });

    it("the detection key is dk_root + h_i and has the default gamma", () => {
        const dk = fmdDiversifiedDetectionKey(P, dkRoot);
        expect(dk.x).toHaveLength(FMD_DEFAULT_GAMMA);
        for (const [i, x] of dk.x.entries()) expect(x).toBe((dkRoot + fmdExpandScalar2(P, i)) % q);
        expect(fmdDiversifiedDetectionKey(P, dkRoot + q)).toEqual(dk);
    });

    it("the flag key is the detection key times g_d", () => {
        const dk = fmdDiversifiedDetectionKey(P, dkRoot, 8);
        for (const d of ds) {
            const { g_d, ck_d } = buildDiversifiedKeys(P, J, ivk, d);
            const fk = fmdDiversifiedFlagKey(J, P, ck_d, g_d, 8);
            expect(fk.X).toEqual(dk.x.map((x) => J.mulPointEscalar(g_d, x)));
        }
    });

    it("on Base8 it produces exactly fmdFlag's clue", () => {
        const rng = lcgScalars(0xba5e8n);
        for (const gamma of [1, 5, 8, 16]) {
            const dk = { x: Array.from({ length: gamma }, rng) };
            const fk = fmdFlagKeyFromDetection(J, dk);
            for (let n = 0; n < 8; n++) {
                const r = rng();
                const clue = fmdFlagOnBase(J, P, fk, J.base8, r);
                expect(clue).toEqual(fmdFlag(J, P, fk, r));
                expect(fmdTest(J, P, dk, clue)).toBe(true);
            }
        }
    });

    it("one detection key detects clues for every address of the user", () => {
        const dk = fmdDiversifiedDetectionKey(P, dkRoot);
        const rng = lcgScalars(0xc1ea5en);
        for (const d of ds) {
            for (let n = 0; n < 8; n++) {
                expect(fmdTest(J, P, dk, flagFor(d, rng()))).toBe(true);
            }
        }
    });

    it("another user's detection key accepts at about 2^-gamma", () => {
        const other = fmdDiversifiedDetectionKey(P, deriveDkRoot(P, deriveIvk(P, 43n)));
        const rng = lcgScalars(0xfa15en);
        const trials = 640;
        let accepted = 0;
        for (let n = 0; n < trials; n++) {
            if (fmdTest(J, P, other, flagFor(ds[n % ds.length]!, rng()))) accepted++;
        }
        // Expected 640 / 32 = 20, standard deviation ~4.4; these inputs give 21. The inputs are
        // fixed, so the count is too. The band fails on a rate of 2^-(gamma - 1) or 2^-(gamma + 2).
        expect(accepted).toBeGreaterThan(8);
        expect(accepted).toBeLessThan(40);
    });

    it("the recipient recomputes the sender's clue from (dk_root, d, r)", () => {
        const rng = lcgScalars(0x5eedn);
        for (const d of ds) {
            for (const gamma of [FMD_DEFAULT_GAMMA, 14]) {
                const r = rng();
                expect(fmdExpectedClue(J, P, dkRoot, d, r, gamma)).toEqual(flagFor(d, r, gamma));
            }
        }
    });

    it("a clue mixing one address's ck with another's base is not the recomputed clue", () => {
        // gamma 16 keeps a coincidence of every bit at 2^-16 per case; at the default 5 one case
        // in 32 would match by chance.
        const gamma = 16;
        const [d1, d2] = [ds[0]!, ds[1]!];
        const a1 = buildDiversifiedKeys(P, J, ivk, d1);
        const a2 = buildDiversifiedKeys(P, J, ivk, d2);
        const rng = lcgScalars(0xc0ffeen);
        for (let n = 0; n < 8; n++) {
            const r = rng();
            const mixed = fmdFlagOnBase(
                J,
                P,
                fmdDiversifiedFlagKey(J, P, a1.ck_d, a2.g_d, gamma),
                a2.g_d,
                r,
            );
            const expected = fmdExpectedClue(J, P, dkRoot, d2, r, gamma);
            // Same base and r, so the same R; the bits are what differ.
            expect(mixed.R).toEqual(expected.R);
            expect(mixed.bits).not.toEqual(expected.bits);
            expect(mixed).not.toEqual(fmdExpectedClue(J, P, dkRoot, d1, r, gamma));
        }
    });

    it("a clue for one address is not the recomputed clue of another", () => {
        const r = 12345n;
        expect(flagFor(ds[0]!, r)).not.toEqual(fmdExpectedClue(J, P, dkRoot, ds[1]!, r));
    });

    it("rejects r that is zero mod q", () => {
        const { g_d, ck_d } = buildDiversifiedKeys(P, J, ivk, ds[0]!);
        const fk = fmdDiversifiedFlagKey(J, P, ck_d, g_d);
        for (const r of [0n, q, 2n * q]) {
            expect(() => fmdFlagOnBase(J, P, fk, g_d, r)).toThrow(/r must be non-zero mod q/);
            expect(() => fmdExpectedClue(J, P, dkRoot, ds[0]!, r)).toThrow(
                /r must be non-zero mod q/,
            );
        }
    });
});
