import { beforeAll, describe, expect, it } from "vitest";
import { toLeBytes } from "../core/bytes.js";
import { BN254_FR } from "../core/field.js";
import { bytesToBareHex } from "../core/hex.js";
import { DIVERSIFIER_BOUND, diversifiedBase, findDiversifiedBase } from "./diversified-base.js";
import type { Point } from "./jubjub.js";
import { Jubjub } from "./jubjub-wasm/index.js";
import { Poseidon } from "./poseidon.js";

const isIdentity = (p: Point) => p[0] === 0n && p[1] === 1n;

/** Literal, not the import: the test pins the tag value. */
const TAG_GD = 16n;

describe("diversified base", () => {
    let J: Jubjub;
    let P: Poseidon;
    beforeAll(async () => {
        J = await Jubjub.build();
        P = await Poseidon.build();
    });

    const candidate = (d: bigint, ctr: number) =>
        J.unpackPoint(toLeBytes(P.hash([TAG_GD, d, BigInt(ctr)])));

    const SAMPLE = [0n, 1n, 2n, 7n, 0xdead_beefn, (1n << 64n) + 3n, DIVERSIFIER_BOUND - 1n];

    it.each(SAMPLE)("d = %d: deterministic, in the prime-order subgroup, not the identity", (d) => {
        const g = diversifiedBase(J, P, d);
        expect(diversifiedBase(J, P, d)).toEqual(g);
        expect(J.inSubgroup(g)).toBe(true);
        expect(isIdentity(g)).toBe(false);
    });

    it("differs across diversifiers", () => {
        const packed = Array.from({ length: 64 }, (_, d) =>
            bytesToBareHex(J.packPoint(diversifiedBase(J, P, BigInt(d)))),
        );
        expect(new Set(packed).size).toBe(64);
    });

    it("is [8] times the first decodable candidate", () => {
        for (let d = 0n; d < 32n; d++) {
            const { g_d, ctr } = findDiversifiedBase(J, P, d);
            for (let earlier = 0; earlier < ctr; earlier++) {
                expect(candidate(d, earlier)).toBeNull();
            }
            const p0 = candidate(d, ctr);
            expect(p0).not.toBeNull();
            // The packed sign bit is clear, so the decoder returns the non-negative abscissa.
            expect(p0![0]).toBeLessThanOrEqual((BN254_FR - 1n) / 2n);
            expect(g_d).toEqual(J.mulPointEscalar(p0!, 8n));
        }
    });

    // Pinned counters. d = 1 and d = 7 are the smallest diversifiers whose counter-0 candidate is
    // not the ordinate of a curve point.
    it.each([
        [0n, 0],
        [1n, 4],
        [7n, 1],
    ])("d = %d uses counter %i", (d, ctr) => {
        expect(findDiversifiedBase(J, P, d).ctr).toBe(ctr);
        expect(candidate(d, 0) === null).toBe(ctr !== 0);
    });

    it("pins the result when counter 0 does not decode", () => {
        expect(candidate(1n, 0)).toBeNull();
        expect(bytesToBareHex(J.packPoint(diversifiedBase(J, P, 1n)))).toBe(
            "48e93666d3dad2342f03efd96eda38b3e248e2c4860b40df2c4f2c0bfed2a1ad",
        );
    });

    it("uses counters in the expected proportion", () => {
        // About half of all ordinates decode, so counter 0 serves about half of all d.
        let first = 0;
        for (let d = 0n; d < 64n; d++) if (findDiversifiedBase(J, P, d).ctr === 0) first++;
        expect(first).toBe(33);
    });

    it("rejects a value that is not a 16-byte diversifier", () => {
        expect(() => diversifiedBase(J, P, DIVERSIFIER_BOUND)).toThrow(/16-byte diversifier/);
        expect(() => diversifiedBase(J, P, -1n)).toThrow(/16-byte diversifier/);
    });

    // The decoder behaviour the loop depends on. A candidate that packs a low-order point must not
    // become a base: `unpackPoint` refuses x = 0, and the remaining torsion is caught by the
    // identity check after `[8]`.
    describe("decoder edge cases", () => {
        it("refuses the identity and the order-2 point", () => {
            expect(J.unpackPoint(toLeBytes(1n))).toBeNull();
            expect(J.unpackPoint(toLeBytes(BN254_FR - 1n))).toBeNull();
        });

        it("decodes an order-4 point, which [8] sends to the identity", () => {
            const p = J.unpackPoint(toLeBytes(0n));
            expect(p).not.toBeNull();
            expect(J.inSubgroup(p!)).toBe(false);
            expect(isIdentity(J.mulPointEscalar(p!, 8n))).toBe(true);
        });

        it("refuses an ordinate at or above the field modulus", () => {
            // BN254_FR + 2 fits in 254 bits, so the sign bit is clear and only the range check
            // can refuse it.
            expect(J.unpackPoint(toLeBytes(BN254_FR + 2n))).toBeNull();
        });
    });
});
