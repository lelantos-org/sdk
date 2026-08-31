import { describe, expect, it } from "vitest";
import { circuitAmount } from "./brand.js";
import {
    decompose,
    descendingAtMost,
    isDenomination,
    largestAtMost,
    nearest,
    resolveLadder,
    universalLadder,
} from "./denominations.js";
import { RAY, toTokenUnits } from "./units.js";

// The two assets this module used to carry a hand-tuned table for, now
// described only by what the pool and the ERC-20 already report.
const USDC = { scale: 1n, decimals: 6 };
const WETH = { scale: 10_000_000_000n, decimals: 18 };

const usdc = () => universalLadder(USDC);

/** A mid-ladder rung, worth 1000 USDC at an index of RAY (`scale = 1`). */
const ONE_THOUSAND_USDC = 1_000_000_000n;

describe("ladder is index-invariant", () => {
    // The decisive property, and the one an index-unaware suite would never
    // surface. A ladder derived from human amounts — `n = human * RAY /
    // (scale * index)` — moves as the index moves, handing every user a
    // different integer, which is exactly the fingerprint denominations exist
    // to remove.
    it("is fixed integers, derived from static metadata and never the index", () => {
        // Pinned literally. A refactor deriving these from human amounts would
        // still pass at an index of RAY and diverge everywhere else, so the
        // guard has to be the integers themselves rather than a round trip.
        expect(usdc()).toEqual([
            100_000n,
            200_000n,
            500_000n,
            1_000_000n,
            2_000_000n,
            5_000_000n,
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
            200_000_000_000n,
            500_000_000_000n,
        ]);
        // One argument, and it carries only static asset properties: there is
        // no index in scope for the value to depend on. Pinned on the function
        // rather than on the fixture, so it fails if an index ever creeps in.
        expect(universalLadder.length).toBe(1);
    });

    it("a denomination's worth moves with the index; the denomination does not", () => {
        // Named, not positional: reaching in by index silently retargets to a
        // different rung if the window ever moves, where this fails.
        const before = ONE_THOUSAND_USDC;
        expect(isDenomination(before, usdc())).toBe(true);

        expect(toTokenUnits(circuitAmount(before), 1n, { index: RAY })).toBe(1_000_000_000n);
        expect(toTokenUnits(circuitAmount(before), 1n, { index: (RAY * 105n) / 100n })).toBe(
            1_050_000_000n,
        );
        expect(toTokenUnits(circuitAmount(before), 1n, { index: RAY * 2n })).toBe(2_000_000_000n);

        // The point: what it is worth moved three times, the integer published
        // on chain did not.
        expect(isDenomination(before, usdc())).toBe(true);
    });
});

describe("universalLadder", () => {
    it("keeps the floor the curated ladders chose, and caps above them", () => {
        // The floor is the bound that matters for dust, and it lands exactly
        // where the hand-tuned WETH ladder put it: 0.001. The cap is the loose
        // end of the trade — 5000 rather than 50 — because one cap in circuit
        // units cannot be right for two assets 3000x apart in price.
        const weth = universalLadder(WETH);
        expect(toTokenUnits(circuitAmount(weth[0] as bigint), WETH.scale)).toBe(10n ** 15n);
        expect(toTokenUnits(circuitAmount(weth.at(-1) as bigint), WETH.scale)).toBe(
            5000n * 10n ** 18n,
        );
    });

    it("gives two differently scaled assets the same ladder", () => {
        // The finding the table encoded and this replaces: an operator picks
        // `scale` to make a circuit unit a sensible granularity, which leaves
        // circuit units roughly value-normalised across assets. USDC and WETH
        // land on one window — the curated pair were already within two
        // decades of each other.
        expect(universalLadder(WETH)).toEqual(usdc());
    });

    it("means what the old curated ladders meant, at each asset's scale", () => {
        // 1e5 circuit units: $0.10 of USDC, 0.001 WETH — the latter exactly
        // the floor the hand-tuned WETH ladder chose, and for the same reason
        // (dust is bounded by the lowest rung).
        expect(usdc()[0]).toBe(100_000n);
        expect(toTokenUnits(circuitAmount(100_000n), WETH.scale)).toBe(1_000_000_000_000_000n);
        // scale 1e10: one whole WETH is 1e8 circuit units.
        expect(toTokenUnits(circuitAmount(100_000_000n), WETH.scale)).toBe(
            1_000_000_000_000_000_000n,
        );
    });

    it("needs no decimals, and gives the same ladder without them", () => {
        // An adapter with no `tokenMeta` used to mean no ladder at all. It now
        // means only that the clamp has nothing to narrow against — which for
        // a sanely scaled asset changes nothing.
        expect(universalLadder({ scale: USDC.scale })).toEqual(usdc());
        expect(universalLadder({ scale: WETH.scale })).toEqual(usdc());
    });

    it("follows the asset when its granularity is nowhere near the default", () => {
        // 18 decimals at scale 1: one circuit unit is 1e-18 of a token, so the
        // universal window describes amounts far too small to withdraw — a
        // one-token withdrawal against its cap would need millions of pieces.
        // The window moves to where the asset lives instead of intersecting to
        // nothing.
        const fine = universalLadder({ scale: 1n, decimals: 18 });
        const whole = 10n ** 18n;
        expect(fine[0]).toBe(whole / 1000n); // 0.001 of a token
        expect(fine.at(-1)).toBe(whole * 500_000n);
    });

    it("never returns an empty ladder, whatever the asset looks like", () => {
        for (const decimals of [0, 2, 6, 8, 18, 24]) {
            for (const scale of [1n, 10n ** 10n, 10n ** 20n]) {
                expect(universalLadder({ scale, decimals }).length).toBeGreaterThan(0);
            }
        }
    });

    it("is ascending with no duplicates", () => {
        for (const l of [usdc(), universalLadder(WETH), universalLadder({ scale: 1n })]) {
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
        expect(descendingAtMost(99_999n, usdc(), 3)).toEqual([]);
    });

    it("returns fewer than `limit` when the ladder runs out", () => {
        expect(descendingAtMost(200_000n, usdc(), 5)).toEqual([200_000n, 100_000n]);
    });
});

describe("resolveLadder — the opt-out", () => {
    it("derives a ladder for every asset by default", () => {
        expect(resolveLadder(USDC)).toEqual(usdc());
        expect(resolveLadder(USDC, true)).toEqual(usdc());
        // Including one no table would ever have listed.
        expect(resolveLadder({ scale: 1n, decimals: 8 })).not.toEqual([]);
    });

    it("returns nothing when opted out, for every asset", () => {
        // `false` must restore pre-denomination behaviour everywhere, and is
        // now the only reason an asset has no ladder.
        expect(resolveLadder(USDC, false)).toEqual([]);
        expect(resolveLadder(WETH, false)).toEqual([]);
    });

    it("returns [] rather than undefined when opted out, so consumers need no null check", () => {
        expect(resolveLadder({ scale: 10n ** 30n, decimals: 0 }, false)).toEqual([]);
    });
});
