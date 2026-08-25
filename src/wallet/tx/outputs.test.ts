import { describe, expect, it } from "vitest";
import type { DecodedAddress } from "../../keys/address.js";
import { changeSlots, finalizeSlots, payTo, splitChange } from "./outputs.js";

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

// Ownership rides on the slot rather than being recomputed as indices against
// an order defined elsewhere — which is what the fee slot kept getting wrong.

const OWN = { pk: PK } as unknown as DecodedAddress;

describe("changeSlots", () => {
    it("addresses every slot back to self", () => {
        const slots = changeSlots(PK, OWN, ASSET, 10n, 3);
        expect(slots).toHaveLength(3);
        expect(slots.every((s) => s.own)).toBe(true);
        expect(slots.every((s) => s.recipient === OWN)).toBe(true);
        expect(slots.reduce((a, s) => a + s.note.value, 0n)).toBe(10n);
    });
});

// `finalizeSlots` shuffles, so the interesting property is that the arrays,
// `ownIndices` and `payeeIndex` all describe the *same* permutation. `pick` is
// the seam that lets a test name the permutation it is asserting about.

const THEIRS = { pk: 99n } as unknown as DecodedAddress;

/** `pick` replaying a fixed queue of draws. */
const pinned = (draws: number[]) => {
    let i = 0;
    return () => draws[i++]!;
};

/** [ours, ours, theirs] — two change slots and a relayer's fee note. */
const changeAndFee = () => {
    const mine = changeSlots(PK, OWN, ASSET, 10n, 2);
    return [mine[0]!, mine[1]!, payTo(splitChange(99n, ASSET, 3n, 1)[0]!, THEIRS, false)];
};

describe("finalizeSlots", () => {
    it("moves note, recipient and ownership together", () => {
        // pick(3) = 0 then pick(2) = 0 swaps 2<->0 and then 1<->0, taking
        // [ours, ours, theirs] to [ours, theirs, ours].
        const slots = changeAndFee();
        const { args, ownIndices } = finalizeSlots(slots, pinned([0, 0]));

        expect(args.outputs).toEqual([slots[1]!.note, slots[2]!.note, slots[0]!.note]);
        expect(args.outputRecipients).toEqual([OWN, THEIRS, OWN]);
        expect(ownIndices).toEqual([0, 2]);
    });

    it("keeps the three arrays aligned per slot under any permutation", () => {
        // The failure this file exists to prevent: a fee note carrying another
        // slot's randomness balances, proves, and is undecryptable by the only
        // party that needed to read it.
        const { args } = finalizeSlots(changeAndFee());
        for (const [j, note] of args.outputs.entries()) {
            const own = note.pk === PK;
            expect(args.outputRecipients[j]).toBe(own ? OWN : THEIRS);
            expect(args.outputRandomness[j]).toBeDefined();
        }
    });

    it("puts the fee anywhere, not last", () => {
        const seen = new Set<number>();
        for (let i = 0; i < 200; i++) {
            seen.add(finalizeSlots(changeAndFee()).args.outputs.findIndex((n) => n.pk !== PK));
        }
        expect([...seen].sort()).toEqual([0, 1, 2]);
    });

    it("reports where the payee's slot landed, and omits it when there is none", () => {
        const mine = changeSlots(PK, OWN, ASSET, 10n, 1);
        const payee = { ...payTo(mine[0]!.note, THEIRS, false), payee: true };
        // pick(2) = 0 swaps 1<->0, so the payee moves off slot 0.
        expect(finalizeSlots([payee, mine[0]!], pinned([0])).payeeIndex).toBe(1);
        expect(finalizeSlots(mine).payeeIndex).toBeUndefined();
    });

    it("is empty when nothing is ours", () => {
        const mine = changeSlots(PK, OWN, ASSET, 10n, 1);
        expect(finalizeSlots([{ ...mine[0]!, own: false }]).ownIndices).toEqual([]);
    });
});
