import { describe, expect, it } from "vitest";
import { randomBelow, shuffled } from "./random.js";

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
