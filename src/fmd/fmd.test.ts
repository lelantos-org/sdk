import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { bytesToHex, hexToBytes } from "../core/hex.js";
import { BABYJUB_SUBGROUP_ORDER, Jubjub, Poseidon } from "../crypto/index.js";
import {
    assertDetectionGamma,
    decodeClue,
    encodeClue,
    FMD_DEFAULT_GAMMA,
    FMD_DOMAIN,
    FMD_SENDER_GAMMA,
    fmdClueKeyFromRoot,
    fmdExpandDetectionKey,
    fmdExpandFlagKey,
    fmdFlag,
    fmdFlagKeyFromDetection,
    fmdTest,
} from "./fmd.js";

describe("detection gamma ceiling", () => {
    let J: Jubjub;
    let P: Poseidon;
    beforeAll(async () => {
        J = await Jubjub.build();
        P = await Poseidon.build();
    });

    it("a key longer than the sender gamma loses the recipient's own notes", () => {
        // Senders pack FMD_SENDER_GAMMA bits and zero-pad the rest, while
        // detection tests every bit of the key, so each padding bit rejects a
        // genuine note with probability 1/2.
        const root = 0x1234_5678n;
        const ck = fmdClueKeyFromRoot(J, root);
        const flag = fmdExpandFlagKey(J, P, ck, FMD_SENDER_GAMMA);

        const overlong = fmdExpandDetectionKey(J, P, root, FMD_SENDER_GAMMA + 3);
        const matched = Array.from({ length: 64 }, (_, i) => {
            const clue = fmdFlag(J, P, flag, BigInt(i) + 1n);
            // The wire prefix is 16 bits wide with the unused bits zero; a
            // longer clue is reconstructed from it server-side.
            const padded = { ...clue, gamma: overlong.x.length };
            return fmdTest(J, P, overlong, padded);
        }).filter(Boolean).length;

        // 64 at a matching gamma; ~1/8 of that at three extra bits.
        expect(matched).toBeLessThan(30);

        const exact = fmdExpandDetectionKey(J, P, root, FMD_SENDER_GAMMA);
        for (let i = 0; i < 64; i++) {
            expect(fmdTest(J, P, exact, fmdFlag(J, P, flag, BigInt(i) + 1n))).toBe(true);
        }
    });

    it("rejects a gamma above the sender gamma", () => {
        expect(() => assertDetectionGamma(FMD_SENDER_GAMMA + 1)).toThrow(/exceeds the sender/);
        expect(() => assertDetectionGamma(0)).toThrow(/positive integer/);
        expect(() => assertDetectionGamma(FMD_SENDER_GAMMA)).not.toThrow();
    });
});

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

    it("foreign detection statistically near 2^-γ", { timeout: 120_000 }, () => {
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

// ── clue-key expansion ───────────────────────────────────────────────────
//
// The property the address format depends on: publishing `ck` allows flagging
// and does not allow detection.
describe("FMD clue-key expansion", () => {
    let J: Jubjub;
    let P: Poseidon;
    beforeAll(async () => {
        J = await Jubjub.build();
        P = await Poseidon.build();
    });

    const DK_ROOT = 0x5eed_1234_abcdn;

    it("the two halves agree: X_i = B · x_i", () => {
        for (const gamma of [1, 3, FMD_DEFAULT_GAMMA, 8, 14]) {
            const ck = fmdClueKeyFromRoot(J, DK_ROOT);
            const flag = fmdExpandFlagKey(J, P, ck, gamma);
            const detection = fmdExpandDetectionKey(J, P, DK_ROOT, gamma);
            expect(flag.X).toEqual(fmdFlagKeyFromDetection(J, detection).X);
        }
    });

    it("a sender holding only ck can flag, and the recipient detects it", () => {
        const ck = fmdClueKeyFromRoot(J, DK_ROOT);
        // Everything a sender has: no dk_root is in scope for this call.
        const flag = fmdExpandFlagKey(J, P, ck);
        const clue = fmdFlag(J, P, flag, 0xf1a6n);

        expect(fmdTest(J, P, fmdExpandDetectionKey(J, P, DK_ROOT), clue)).toBe(true);
    });

    it("ck alone does not yield a working detection key", () => {
        const ck = fmdClueKeyFromRoot(J, DK_ROOT);
        const clue = fmdFlag(J, P, fmdExpandFlagKey(J, P, ck), 0xf1a6n);

        // Public material only yields a detection key rooted at a guess.
        // `ck`'s coordinates are the nearest candidates; the discrete log
        // separates them from dk_root.
        for (const guess of [ck[0], ck[1], 0n, 1n]) {
            expect(fmdTest(J, P, fmdExpandDetectionKey(J, P, guess), clue)).toBe(false);
        }
    });

    it("distinct roots give distinct clue keys and do not cross-detect", () => {
        const a = fmdClueKeyFromRoot(J, DK_ROOT);
        const b = fmdClueKeyFromRoot(J, DK_ROOT + 1n);
        expect(a).not.toEqual(b);

        const clueForA = fmdFlag(J, P, fmdExpandFlagKey(J, P, a), 0xbeefn);
        expect(fmdTest(J, P, fmdExpandDetectionKey(J, P, DK_ROOT + 1n), clueForA)).toBe(false);
    });

    it("binds ck into every subkey, so expansion is per-recipient", () => {
        // If h_i ignored ck, two recipients' flag keys would differ only by the
        // constant offset ck_a - ck_b, and one clue would test true under both.
        const a = fmdExpandFlagKey(J, P, fmdClueKeyFromRoot(J, DK_ROOT));
        const b = fmdExpandFlagKey(J, P, fmdClueKeyFromRoot(J, DK_ROOT + 1n));
        const offsets = a.X.map((Xa, i) => {
            const Xb = b.X[i]!;
            return `${Xa[0] - Xb[0]},${Xa[1] - Xb[1]}`;
        });
        expect(new Set(offsets).size).toBe(offsets.length);
    });
});

// ── cross-language vectors ───────────────────────────────────────────────
//
// `tests/vectors/fmd.json` is generated by `npm run gen:vectors` and pins the
// FMD wire format against the Rust indexer.
describe("cross-language vectors (tests/vectors/fmd.json)", () => {
    let J: Jubjub;
    let P: Poseidon;
    beforeAll(async () => {
        J = await Jubjub.build();
        P = await Poseidon.build();
    });

    const vectors = JSON.parse(
        readFileSync(new URL("../../tests/vectors/fmd.json", import.meta.url), "utf8"),
    ) as {
        version: number;
        domain: string;
        vectors: {
            label: string;
            gamma: number;
            dk_x: string[];
            fk_X: { x: string; y: string }[];
            r: string;
            clue_R: string;
            clue_bits: string;
            clue_encoded: string;
            detect_self: boolean;
            detect_other: boolean;
        }[];
        expansion: {
            label: string;
            gamma: number;
            dk_root: string;
            ck: { x: string; y: string };
            ck_packed: string;
            dk_x: string[];
            fk_X: { x: string; y: string }[];
            r: string;
            clue_encoded: string;
            detect_self: boolean;
            other_root: string;
            detect_other: boolean;
        }[];
    };

    it("matches the scheme version the fixture was generated for", () => {
        expect(vectors.version).toBe(4);
        expect(vectors.domain).toBe(FMD_DOMAIN);
    });

    for (const v of vectors.vectors) {
        describe(v.label, () => {
            it("derives the recorded flag key from the detection key", () => {
                const dk = { x: v.dk_x.map(BigInt) };
                const fk = fmdFlagKeyFromDetection(J, dk);
                expect(fk.X.map((p) => ({ x: p[0].toString(), y: p[1].toString() }))).toEqual(
                    v.fk_X,
                );
            });

            it("reproduces the recorded clue byte-for-byte", () => {
                const dk = { x: v.dk_x.map(BigInt) };
                const fk = fmdFlagKeyFromDetection(J, dk);
                const clue = fmdFlag(J, P, fk, BigInt(v.r));

                expect(bytesToHex(clue.R)).toBe(v.clue_R);
                expect(bytesToHex(clue.bits)).toBe(v.clue_bits);
                expect(bytesToHex(encodeClue(clue))).toBe(v.clue_encoded);
                expect(clue.gamma).toBe(v.gamma);
            });

            it("detects with the owning key and not with another", () => {
                const dk = { x: v.dk_x.map(BigInt) };
                const clue = decodeClue(hexToBytes(v.clue_encoded));

                expect(fmdTest(J, P, dk, clue)).toBe(v.detect_self);

                const other = { x: v.dk_x.map((x) => BigInt(x) + 1n) };
                expect(fmdTest(J, P, other, clue)).toBe(v.detect_other);
            });
        });
    }

    for (const v of vectors.expansion) {
        describe(`expansion ${v.label}`, () => {
            it("derives the recorded clue key from the root secret", () => {
                const ck = fmdClueKeyFromRoot(J, BigInt(v.dk_root));
                expect({ x: ck[0].toString(), y: ck[1].toString() }).toEqual(v.ck);
                expect(bytesToHex(J.packPoint(ck))).toBe(v.ck_packed);
            });

            it("expands both halves to the recorded values", () => {
                const detection = fmdExpandDetectionKey(J, P, BigInt(v.dk_root), v.gamma);
                expect(detection.x.map(String)).toEqual(v.dk_x);

                const ck = fmdClueKeyFromRoot(J, BigInt(v.dk_root));
                const flag = fmdExpandFlagKey(J, P, ck, v.gamma);
                expect(flag.X.map((p) => ({ x: p[0].toString(), y: p[1].toString() }))).toEqual(
                    v.fk_X,
                );
            });

            it("detects with the expanded key, and matches the pinned foreign result", () => {
                const clue = decodeClue(hexToBytes(v.clue_encoded));
                const mine = fmdExpandDetectionKey(J, P, BigInt(v.dk_root), v.gamma);
                expect(fmdTest(J, P, mine, clue)).toBe(v.detect_self);

                // A foreign key matching is the designed 2^-gamma false
                // positive, so the fixture pins the outcome.
                const other = fmdExpandDetectionKey(J, P, BigInt(v.other_root), v.gamma);
                expect(fmdTest(J, P, other, clue)).toBe(v.detect_other);
            });
        });
    }
});
