import { beforeAll, describe, expect, it } from "vitest";
import { bitAt } from "../core/bits.js";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR } from "../core/field.js";
import { deriveIvk } from "../crypto/derive.js";
import { diversifiedBase } from "../crypto/diversified-base.js";
import type { Point } from "../crypto/jubjub.js";
import { Jubjub } from "../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../crypto/poseidon.js";
import { legendreSymbol } from "../crypto/sqrt.js";
import { TAG_FMD_BIT } from "../crypto/tags.js";
import { buildDiversifiedKeys, deriveDkRoot } from "../keys/diversified.js";
import { diversifierForIndex } from "../keys/diversifier.js";
import { lcgScalars } from "../test-utils/lcg.js";
import { fmdFlagOnBase, fmdTest } from "./clue.js";
import {
    fmdDiversifiedDetectionKey,
    fmdDiversifiedFlagKey,
    fmdExpansionScalar,
    fmdExpectedClue,
    fmdExpectedClueOnBase,
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
        ds = [0, 1, 2, 3, 77, 2 ** 32 - 1].map((index) => diversifierForIndex(ivk, index));
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
            expect(fmdExpansionScalar(P, i)).toBe(P.hash([17n, BigInt(i)]) % q);
        }
        expect(new Set(Array.from({ length: 14 }, (_, i) => fmdExpansionScalar(P, i))).size).toBe(
            14,
        );
    });

    it("the detection key is dk_root + h_i and has the default gamma", () => {
        const dk = fmdDiversifiedDetectionKey(P, dkRoot);
        expect(dk.x).toHaveLength(FMD_DEFAULT_GAMMA);
        for (const [i, x] of dk.x.entries())
            expect(x).toBe((dkRoot + fmdExpansionScalar(P, i)) % q);
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

    it("a raw detection key accepts clues flagged on the base its flag key was built on", () => {
        const rng = lcgScalars(0xba5e8n);
        const bases = [J.base8, buildDiversifiedKeys(P, J, ivk, ds[1]!).g_d];
        for (const gamma of [1, 5, 8, 16]) {
            const dk = { x: Array.from({ length: gamma }, rng) };
            for (const base of bases) {
                const fk = fmdFlagKeyFromDetection(J, dk, base);
                expect(fk.X).toEqual(dk.x.map((x) => J.mulPointEscalar(base, x)));
                for (let n = 0; n < 4; n++) {
                    const clue = fmdFlagOnBase(J, P, fk, base, rng());
                    expect(clue.gamma).toBe(gamma);
                    expect(fmdTest(J, P, dk, clue)).toBe(true);
                }
            }
        }
    });

    it("a clue's R is r times the base it was flagged on", () => {
        const { g_d, ck_d } = buildDiversifiedKeys(P, J, ivk, ds[0]!);
        const fk = fmdDiversifiedFlagKey(J, P, ck_d, g_d);
        const r = 0xf1a6n;
        expect(fmdFlagOnBase(J, P, fk, g_d, r).R).toEqual(J.packPoint(J.mulPointEscalar(g_d, r)));
        expect(fmdFlagOnBase(J, P, fk, g_d, r).R).not.toEqual(
            J.packPoint(J.mulPointEscalar(J.base8, r)),
        );
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

    it("the clue recomputed on a held base and detection key is the one from (dk_root, d)", () => {
        const rng = lcgScalars(0x0ba5en);
        for (const gamma of [1, FMD_DEFAULT_GAMMA, 16]) {
            const dk = fmdDiversifiedDetectionKey(P, dkRoot, gamma);
            for (const d of [ds[0]!, ds[1]!, ds[5]!]) {
                const g_d = diversifiedBase(J, P, d);
                // `q + 5` is unreduced: both reduce the blinder mod q.
                for (const r of [1n, q - 1n, q + 5n, rng()]) {
                    const onBase = fmdExpectedClueOnBase(J, P, dk, g_d, r);
                    expect(onBase).toEqual(fmdExpectedClue(J, P, dkRoot, d, r, gamma));
                    expect(onBase.gamma).toBe(gamma);
                }
            }
        }
        // The default gamma of `fmdExpectedClue` is that of the default detection key.
        const dk = fmdDiversifiedDetectionKey(P, dkRoot);
        expect(fmdExpectedClueOnBase(J, P, dk, diversifiedBase(J, P, ds[2]!), 7n)).toEqual(
            fmdExpectedClue(J, P, dkRoot, ds[2]!, 7n),
        );
    });

    it("each clue bit is the Euler-criterion bit of its shared point, inverted", () => {
        // The scheme written out: `S_i = x_i · R`, `c_i = 1 ⊕ [h_i^((p-1)/2) = 1]`.
        const rng = lcgScalars(0xb175n);
        const dk = fmdDiversifiedDetectionKey(P, dkRoot);
        const cases: [bigint, bigint][] = [];
        for (const d of ds) {
            for (const r of [1n, 2n, q - 1n, q + 1n, 2n * q - 1n]) cases.push([d, r]);
            for (let i = 0; i < 12; i++) cases.push([d, rng()]);
        }
        expect(cases).toHaveLength(102);
        for (const [d, r] of cases) {
            const { g_d, ck_d } = buildDiversifiedKeys(P, J, ivk, d);
            const R = J.mulPointEscalar(g_d, r % q);
            const bits = dk.x.map((x, i) => {
                const S = J.mulPointEscalar(R, x);
                const h = P.hash([TAG_FMD_BIT, R[0], R[1], BigInt(i), S[0], S[1]]);
                return legendreSymbol(h, BN254_FR) === 1 ? 0 : 1;
            });

            const expected = fmdExpectedClueOnBase(J, P, dk, g_d, r);
            expect(expected.R).toEqual(J.packPoint(R));
            expect(bits.map((_, i) => bitAt(expected.bits, i))).toEqual(bits);
            expect(expected.bits).toHaveLength(1);
            expect(fmdFlagOnBase(J, P, fmdDiversifiedFlagKey(J, P, ck_d, g_d), g_d, r)).toEqual(
                expected,
            );
        }
    });

    it("a clue mixing one address's ck_d with another's base is not the recomputed clue", () => {
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
        const dk = fmdDiversifiedDetectionKey(P, dkRoot);
        for (const r of [0n, q, 2n * q]) {
            expect(() => fmdFlagOnBase(J, P, fk, g_d, r)).toThrow(/r must be non-zero mod q/);
            expect(() => fmdExpectedClue(J, P, dkRoot, ds[0]!, r)).toThrow(
                /r must be non-zero mod q/,
            );
            expect(() => fmdExpectedClueOnBase(J, P, dk, g_d, r)).toThrow(
                /r must be non-zero mod q/,
            );
        }
    });
});
