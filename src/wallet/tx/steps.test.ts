import { describe, expect, it } from "vitest";
import { splitChange } from "./steps.js";

// Change goes out as real notes, so the split is part of what an observer
// sees. These pin the two properties that matter: the notes sum to the
// remainder exactly, and the two-slot case is unchanged from when the split
// was hardcoded to a pair.

const PK = 7n;
const ASSET = 1n;
const values = (remainder: bigint, slots: number) =>
    splitChange(PK, ASSET, remainder, slots).map((n) => n.value);

describe("splitChange", () => {
    it("reproduces the original two-slot pair, remainder last", () => {
        expect(values(5n, 2)).toEqual([2n, 3n]);
        expect(values(4n, 2)).toEqual([2n, 2n]);
        expect(values(1n, 2)).toEqual([0n, 1n]);
    });

    it("spreads an indivisible remainder over the last slots", () => {
        expect(values(7n, 3)).toEqual([2n, 2n, 3n]);
        expect(values(8n, 3)).toEqual([2n, 3n, 3n]);
        expect(values(9n, 3)).toEqual([3n, 3n, 3n]);
    });

    it("always sums to the remainder", () => {
        for (const slots of [1, 2, 3, 4]) {
            for (const r of [0n, 1n, 2n, 97n, 10n ** 18n + 7n]) {
                const out = values(r, slots);
                expect(out).toHaveLength(slots);
                expect(out.reduce((a, b) => a + b, 0n)).toBe(r);
            }
        }
    });

    it("carries the asset and owner onto every slot", () => {
        const notes = splitChange(PK, ASSET, 10n, 3);
        expect(notes.every((n) => n.pk === PK && n.asset === ASSET)).toBe(true);
        // Randomness is fresh per note, so no two share a rho.
        expect(new Set(notes.map((n) => n.rho)).size).toBe(3);
    });

    it("rejects a zero-slot split", () => {
        expect(() => splitChange(PK, ASSET, 10n, 0)).toThrow(/at least one slot/);
    });
});
