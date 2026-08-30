import { describe, expect, it } from "vitest";
import { circuitAmount } from "./brand.js";
import {
    BUILT_IN_LADDERS,
    decompose,
    descendingAtMost,
    isDenomination,
    ladderFor,
    largestAtMost,
    nearest,
    resolveLadder,
} from "./denominations.js";
import { RAY, toTokenUnits } from "./units.js";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

const usdc = () => {
    const l = ladderFor(USDC);
    if (!l) throw new Error("no USDC ladder");
    return l;
};

describe("ladder is index-invariant", () => {
    // The decisive property, and the one an index-unaware suite would never
    // surface. A ladder derived from human amounts — `n = human * RAY /
    // (scale * index)` — moves as the index moves, handing every user a
    // different integer, which is exactly the fingerprint denominations exist
    // to remove.
    it("is a table of fixed integers, taking no asset metadata at all", () => {
        // Pinned literally. A refactor deriving these from human amounts would
        // still pass at an index of RAY and diverge everywhere else, so the
        // guard has to be the integers themselves rather than a round trip.
        expect(ladderFor(USDC)).toEqual([
            10_000_000n,
            20_000_000n,
            50_000_000n,
            100_000_000n,
            200_000_000n,
            500_000_000n,
            1_000_000_000n,
            2_000_000_000n,
            5_000_000_000n,
            10_000_000_000n,
            20_000_000_000n,
            50_000_000_000n,
            100_000_000_000n,
        ]);
        // `ladderFor` takes an address and nothing else: there is no index,
        // scale or decimals in scope for the value to depend on.
        expect(ladderFor.length).toBe(1);
    });

    it("a denomination's worth moves with the index; the denomination does not", () => {
        const before = usdc()[6] as bigint;
        expect(before).toBe(1_000_000_000n); // 1000 USDC at RAY, scale 1

        expect(toTokenUnits(circuitAmount(before), 1n, { index: RAY })).toBe(1_000_000_000n);
        expect(toTokenUnits(circuitAmount(before), 1n, { index: (RAY * 105n) / 100n })).toBe(
            1_050_000_000n,
        );
        expect(toTokenUnits(circuitAmount(before), 1n, { index: RAY * 2n })).toBe(2_000_000_000n);

        // The point: what it is worth moved three times, the integer published
        // on chain did not.
        expect(usdc()[6]).toBe(before);
    });
});

describe("ladderFor", () => {
    it("is keyed by address, case-insensitively, never by symbol", () => {
        expect(ladderFor(USDC.toLowerCase())).toBe(ladderFor(USDC.toUpperCase()));
        expect(ladderFor("0x0000000000000000000000000000000000000dead")).toBeUndefined();
    });

    it("gives USDC $10 … $100k in circuit units", () => {
        expect(usdc()[0]).toBe(10_000_000n); // $10 at scale 1
        expect(usdc().at(-1)).toBe(100_000_000_000n); // $100k
        expect(usdc()).toHaveLength(13);
    });

    it("gives WETH 0.001 … 50, where 1e8 units is exactly 1e18 wei", () => {
        const weth = ladderFor(WETH);
        if (!weth) throw new Error("no WETH ladder");
        expect(weth[0]).toBe(100_000n); // 0.001 WETH
        expect(weth.at(-1)).toBe(5_000_000_000n); // 50 WETH
        // scale 1e10: one whole WETH is 1e8 circuit units.
        expect(toTokenUnits(circuitAmount(100_000_000n), 10_000_000_000n)).toBe(
            1_000_000_000_000_000_000n,
        );
    });

    it("is ascending with no duplicates", () => {
        for (const l of [usdc(), ladderFor(WETH) ?? []]) {
            expect([...l].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual([...l]);
            expect(new Set(l).size).toBe(l.length);
        }
    });
});

describe("decompose", () => {
    it("splits greedily onto the ladder with dust last", () => {
        // The worked example: 4900 USDC-equivalent across four slots.
        const { pieces, dust } = decompose(4_900_000_000n, usdc(), 4);
        expect(pieces).toEqual([2_000_000_000n, 2_000_000_000n, 500_000_000n]);
        expect(dust).toBe(400_000_000n);
    });

    it("conserves value exactly, always", () => {
        // Value conservation is enforced in-circuit, so a remainder can never
        // be rounded away — only placed.
        for (const amount of [0n, 1n, 999n, 4_900_000_000n, 123_456_789_012n]) {
            for (const slots of [1, 2, 3, 4]) {
                const { pieces, dust } = decompose(amount, usdc(), slots);
                expect(pieces.reduce((a, b) => a + b, 0n) + dust).toBe(amount);
                expect(pieces.length + (dust > 0n ? 1 : 0)).toBeLessThanOrEqual(slots);
            }
        }
    });

    it("takes the reserved slot as a piece when the remainder is on-ladder", () => {
        // 3000 = 2000 + 1000; the held-back slot should not downgrade an exact
        // split to dust.
        const { pieces, dust } = decompose(3_000_000_000n, usdc(), 4);
        expect(dust).toBe(0n);
        expect(pieces).toEqual([2_000_000_000n, 1_000_000_000n]);
    });

    it("puts everything in dust when nothing on the ladder fits", () => {
        const { pieces, dust } = decompose(5n, usdc(), 4);
        expect(pieces).toEqual([]);
        expect(dust).toBe(5n);
    });

    it("converges: re-splitting dust clears it", () => {
        // Dust is transient because an internal transfer publishes no amount,
        // so a later self-spend re-splits it for free.
        const rest = decompose(4_900_000_000n, usdc(), 4).dust;
        expect(rest).toBe(400_000_000n);
        const second = decompose(rest, usdc(), 4);
        expect(second.pieces).toEqual([200_000_000n, 200_000_000n]);
        expect(second.dust).toBe(0n);
    });

    it("strictly shrinks the residual each round, for arbitrary amounts", () => {
        for (const start of [987_654_321n, 4_900_000_000n, 77_777_777_777n, 10_000_001n]) {
            let rest = start;
            let guard = 0;
            while (rest > 0n && !isDenomination(rest, usdc())) {
                const next = decompose(rest, usdc(), 4).dust;
                if (next === rest) break; // below the lowest denomination
                expect(next).toBeLessThan(rest);
                rest = next;
                expect(guard++).toBeLessThan(20);
            }
            expect(rest).toBeLessThan(usdc()[0] as bigint);
        }
    });

    it("rejects a zero slot count rather than silently dropping value", () => {
        expect(() => decompose(1n, usdc(), 0)).toThrow(RangeError);
    });
});

describe("largestAtMost / nearest / isDenomination", () => {
    it("finds the largest denomination that fits", () => {
        expect(largestAtMost(4_900_000_000n, usdc())).toBe(2_000_000_000n);
        expect(largestAtMost(10_000_000n, usdc())).toBe(10_000_000n);
        expect(largestAtMost(1n, usdc())).toBeUndefined();
    });

    it("rounds to the closest denomination, ties to the smaller", () => {
        expect(nearest(11_000_000n, usdc())).toBe(10_000_000n);
        expect(nearest(15_000_000n, usdc())).toBe(10_000_000n); // tie: 10 vs 20
        expect(nearest(16_000_000n, usdc())).toBe(20_000_000n);
    });

    it("recognises exact members only", () => {
        expect(isDenomination(10_000_000n, usdc())).toBe(true);
        expect(isDenomination(10_000_001n, usdc())).toBe(false);
        expect(isDenomination(0n, usdc())).toBe(false);
    });
});

describe("descendingAtMost", () => {
    it("gives a fallback chain, largest first", () => {
        expect(descendingAtMost(4_900_000_000n, usdc(), 3)).toEqual([
            2_000_000_000n,
            1_000_000_000n,
            500_000_000n,
        ]);
    });

    it("never exceeds `max`, so every entry is a spendable target", () => {
        for (const max of [0n, 1n, 999n, 10_000_000n, 123_456_789n]) {
            for (const d of descendingAtMost(max, usdc(), 3)) expect(d).toBeLessThanOrEqual(max);
        }
    });

    it("is empty below the lowest denomination, which ends the retry chain", () => {
        expect(descendingAtMost(9_999_999n, usdc(), 3)).toEqual([]);
    });

    it("returns fewer than `limit` when the ladder runs out", () => {
        expect(descendingAtMost(20_000_000n, usdc(), 5)).toEqual([20_000_000n, 10_000_000n]);
    });
});

describe("resolveLadder — the opt-out", () => {
    it("uses the built-in table by default", () => {
        expect(resolveLadder(USDC)).toEqual(usdc());
        expect(resolveLadder(USDC, true)).toEqual(usdc());
    });

    it("returns nothing when opted out, for every token", () => {
        // `false` must restore pre-denomination behaviour everywhere, not just
        // for tokens the built-in table happens to miss.
        expect(resolveLadder(USDC, false)).toEqual([]);
        expect(resolveLadder(WETH, false)).toEqual([]);
    });

    it("takes a custom table, replacing the built-ins rather than merging", () => {
        // Replacing, so a caller supplying a map gets exactly what it listed
        // and no surprises from a table it did not write.
        const custom = new Map([["0x000000000000000000000000000000000000dead", [1n, 2n]]]);
        expect(resolveLadder("0x000000000000000000000000000000000000dEaD", custom)).toEqual([
            1n,
            2n,
        ]);
        expect(resolveLadder(USDC, custom)).toEqual([]);
    });

    it("extends the built-ins when spread into a custom map", () => {
        const extended = new Map([
            ...BUILT_IN_LADDERS,
            ["0x000000000000000000000000000000000000dead", [1n, 2n] as const],
        ]);
        expect(resolveLadder(USDC, extended)).toEqual(usdc());
        expect(resolveLadder("0x000000000000000000000000000000000000dEaD", extended)).toEqual([
            1n,
            2n,
        ]);
    });

    it("is case-insensitive on custom tables too", () => {
        const custom = new Map([["0x000000000000000000000000000000000000dead", [1n]]]);
        expect(resolveLadder("0x000000000000000000000000000000000000DEAD", custom)).toEqual([1n]);
    });

    it("returns [] rather than undefined, so consumers need no null check", () => {
        expect(resolveLadder("0x000000000000000000000000000000000000dEaD")).toEqual([]);
    });
});
