import { describe, expect, it } from "vitest";
import { BABYJUB_SUBGROUP_ORDER, BN254_FR } from "./field.js";
import { noteId, randomBelow, randomFr, randomJubjubScalar, shuffled } from "./random.js";

/** A `bytes` stub replaying a fixed queue, so a draw can be pinned exactly. */
function bytesFrom(queue: number[][]): (k: number) => Uint8Array {
    let i = 0;
    return (k) => {
        const next = queue[i++];
        if (next === undefined) throw new Error("bytesFrom: queue exhausted");
        expect(next).toHaveLength(k);
        return Uint8Array.from(next);
    };
}

describe("randomBelow", () => {
    it("rejects a non-positive or non-integer bound", () => {
        expect(() => randomBelow(0)).toThrow(RangeError);
        expect(() => randomBelow(-1)).toThrow(RangeError);
        expect(() => randomBelow(2.5)).toThrow(RangeError);
    });

    it("returns 0 for a bound of 1", () => {
        expect(randomBelow(1)).toBe(0);
    });

    it("stays in range", () => {
        for (const n of [2, 3, 4, 7, 256, 257, 1000]) {
            for (let i = 0; i < 200; i++) {
                const v = randomBelow(n);
                expect(v).toBeGreaterThanOrEqual(0);
                expect(v).toBeLessThan(n);
            }
        }
    });

    it("redraws instead of folding the short final bucket", () => {
        // n = 3 over 32 bits: 2^32 - 1 is the one value above `limit`, so it
        // must be rejected. Folding it would return 0 and bias the split.
        const top = [255, 255, 255, 255];
        expect(randomBelow(3, bytesFrom([top, [0, 0, 0, 7]]))).toBe(1);
    });
});

describe("shuffled", () => {
    const items = [1, 2, 3, 4, 5] as const;

    it("returns a permutation, leaving the input alone", () => {
        const input = [...items];
        const out = shuffled(input);
        expect([...out].sort()).toEqual([...items].sort());
        expect(input).toEqual([...items]);
    });

    it("applies the exact permutation an injected pick asks for", () => {
        // Fisher-Yates downwards, so the draws are pick(5), pick(4), pick(3),
        // pick(2) and the swaps are 4<->0, 3<->1, 2<->2, 1<->0.
        let i = 0;
        const pins = [0, 1, 2, 0];
        expect(shuffled(items, () => pins[i++]!)).toEqual([4, 5, 3, 2, 1]);
        expect(i).toBe(pins.length);
    });

    it("handles empty and single-element inputs", () => {
        expect(shuffled([])).toEqual([]);
        expect(shuffled([42])).toEqual([42]);
    });

    it("reaches every ordering of three elements", () => {
        // Also the cover for the classic off-by-one — looping `i > 0` while
        // picking from `[0, i)` leaves only two of the six orderings reachable.
        const seen = new Set<string>();
        for (let i = 0; i < 500; i++) seen.add(shuffled(["a", "b", "c"]).join(""));
        expect(seen.size).toBe(6);
    });
});

// The masks in `randomFr` / `randomJubjubScalar` only set the acceptance rate;
// correctness rests on the `v < modulus` rejection, so these pin the contract
// rather than the mask. A reduce-instead-of-reject rewrite passes a range check
// but reintroduces bias, so the moduli are asserted at their exact bit widths.
describe("field draws", () => {
    const DRAWS = 400;

    it("randomFr stays in (0, BN254_FR)", () => {
        for (let i = 0; i < DRAWS; i++) {
            const v = randomFr();
            expect(v).toBeGreaterThan(0n);
            expect(v).toBeLessThan(BN254_FR);
        }
    });

    it("randomJubjubScalar stays in (0, BABYJUB_SUBGROUP_ORDER)", () => {
        for (let i = 0; i < DRAWS; i++) {
            const v = randomJubjubScalar();
            expect(v).toBeGreaterThan(0n);
            expect(v).toBeLessThan(BABYJUB_SUBGROUP_ORDER);
        }
    });

    // A draw truncated to a fixed prefix, or one folded with `%` from too few
    // bytes, shows up here as a collision long before it shows up as a bias.
    it("does not repeat", () => {
        const fr = new Set(Array.from({ length: DRAWS }, () => randomFr().toString()));
        const jj = new Set(Array.from({ length: DRAWS }, () => randomJubjubScalar().toString()));
        expect(fr.size).toBe(DRAWS);
        expect(jj.size).toBe(DRAWS);
    });

    // Both draws mask the top byte before rejecting. A mask that cleared too
    // much would still pass the range checks above while quietly capping the
    // draw well below the modulus, so pin that the high end is reachable.
    it("reaches the top of each range", () => {
        const frTop = BN254_FR >> 2n;
        const jjTop = BABYJUB_SUBGROUP_ORDER >> 2n;
        const anyFr = Array.from({ length: DRAWS }, randomFr).some((v) => v > frTop * 3n);
        const anyJj = Array.from({ length: DRAWS }, randomJubjubScalar).some((v) => v > jjTop * 3n);
        expect(anyFr).toBe(true);
        expect(anyJj).toBe(true);
    });
});

describe("noteId", () => {
    // 16 bytes, not 4. The id keys the nullifier memo, `markSpent` and
    // selection's `only` filter, so a collision retires an unrelated note —
    // which at 4 bytes was a ~1% event by 10k notes.
    it("is 128 bits of hex", () => {
        expect(noteId()).toMatch(/^[0-9a-f]{32}$/);
    });

    it("does not repeat", () => {
        const ids = new Set(Array.from({ length: 2000 }, noteId));
        expect(ids.size).toBe(2000);
    });
});
