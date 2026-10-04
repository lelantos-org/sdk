import { beforeAll, describe, expect, it } from "vitest";
import { Jubjub } from "../../crypto/jubjub.js";
import type { DecodedAddress } from "../../keys/address.js";
import { universalLadder } from "../../protocol/denominations.js";
import {
    changeSlots,
    finalizeSlots,
    MAX_CHANGE_NOTES,
    padSlots,
    payTo,
    splitChange,
} from "./outputs.js";

// Change notes sum to the remainder exactly, and a two-note split yields `[floor(r/2), ceil(r/2)]`.

const PK = 7n;
const ASSET = 1n;
const values = (remainder: bigint, maxNotes: number) =>
    splitChange({ pk: PK, asset: ASSET, remainder, maxNotes }).map((n) => n.value);

describe("splitChange", () => {
    it("splits a remainder in two, the larger half last", () => {
        expect(values(5n, 2)).toEqual([2n, 3n]);
        expect(values(4n, 2)).toEqual([2n, 2n]);
    });

    it("emits no zero-value note", () => {
        // A zero-value note to self would carry a clue for the spender's own key.
        expect(values(1n, 2)).toEqual([1n]);
        expect(values(2n, 4)).toEqual([1n, 1n]);
        expect(values(0n, 2)).toEqual([]);
    });

    it("spreads an indivisible remainder over the last notes", () => {
        expect(values(7n, 3)).toEqual([2n, 2n, 3n]);
        expect(values(8n, 3)).toEqual([2n, 3n, 3n]);
        expect(values(9n, 3)).toEqual([3n, 3n, 3n]);
    });

    it("always sums to the remainder", () => {
        for (const maxNotes of [1, 2, 3, 4]) {
            for (const r of [0n, 1n, 2n, 97n, 10n ** 18n + 7n]) {
                const out = values(r, maxNotes);
                expect(out.length).toBeLessThanOrEqual(maxNotes);
                expect(out.every((v) => v > 0n)).toBe(true);
                expect(out.reduce((a, b) => a + b, 0n)).toBe(r);
            }
        }
    });

    it("carries the asset and owner onto every note", () => {
        const notes = splitChange({ pk: PK, asset: ASSET, remainder: 10n, maxNotes: 3 });
        expect(notes.every((n) => n.pk === PK && n.asset === ASSET)).toBe(true);
        // Randomness is fresh per note, so no two share a rho.
        expect(new Set(notes.map((n) => n.rho)).size).toBe(3);
    });

    it("rejects a split into no notes", () => {
        expect(() => splitChange({ pk: PK, asset: ASSET, remainder: 10n, maxNotes: 0 })).toThrow(
            /at least one note/,
        );
    });
});

const OWN = { pk: PK } as unknown as DecodedAddress;

describe("changeSlots", () => {
    it("addresses every slot back to self", () => {
        const slots = changeSlots({
            pk: PK,
            ownAddr: OWN,
            asset: ASSET,
            remainder: 10n,
            maxNotes: 3,
        });
        expect(slots).toHaveLength(3);
        expect(slots.every((s) => s.own)).toBe(true);
        expect(slots.every((s) => s.recipient === OWN)).toBe(true);
        expect(slots.reduce((a, s) => a + s.note.value, 0n)).toBe(10n);
    });
});

// `finalizeSlots` shuffles, so the arrays, `ownIndices` and `payeeIndex` must all describe the same
// permutation. `pick` lets a test pin the permutation.

const THEIRS = { pk: 99n } as unknown as DecodedAddress;

/** `pick` replaying a fixed queue of draws. */
const pinned = (draws: number[]) => {
    let i = 0;
    return () => draws[i++]!;
};

/** [ours, ours, theirs] — two change slots and a relayer's fee note. */
const changeAndFee = () => {
    const mine = changeSlots({ pk: PK, ownAddr: OWN, asset: ASSET, remainder: 10n, maxNotes: 2 });
    return [
        mine[0]!,
        mine[1]!,
        payTo(
            splitChange({ pk: 99n, asset: ASSET, remainder: 3n, maxNotes: 1 })[0]!,
            THEIRS,
            false,
        ),
    ];
};

describe("finalizeSlots", () => {
    it("moves note, recipient and ownership together", () => {
        // pick(3) = 0 then pick(2) = 0 swaps 2<->0 and then 1<->0, taking [ours, ours, theirs] to
        // [ours, theirs, ours].
        const slots = changeAndFee();
        const { args, ownIndices } = finalizeSlots(slots, pinned([0, 0]));

        expect(args.outputs).toEqual([slots[1]!.note, slots[2]!.note, slots[0]!.note]);
        expect(args.outputRecipients).toEqual([OWN, THEIRS, OWN]);
        expect(ownIndices).toEqual([0, 2]);
    });

    it("keeps the three arrays aligned per slot under any permutation", () => {
        // A fee note carrying another slot's randomness balances and proves but cannot be decrypted
        // by the relayer.
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
        const mine = changeSlots({
            pk: PK,
            ownAddr: OWN,
            asset: ASSET,
            remainder: 10n,
            maxNotes: 1,
        });
        const payee = { ...payTo(mine[0]!.note, THEIRS, false), payee: true };
        // pick(2) = 0 swaps 1<->0, so the payee moves off slot 0.
        expect(finalizeSlots([payee, mine[0]!], pinned([0])).payeeIndex).toBe(1);
        expect(finalizeSlots(mine).payeeIndex).toBeUndefined();
    });

    it("is empty when nothing is ours", () => {
        const mine = changeSlots({
            pk: PK,
            ownAddr: OWN,
            asset: ASSET,
            remainder: 10n,
            maxNotes: 1,
        });
        expect(finalizeSlots([{ ...mine[0]!, own: false }]).ownIndices).toEqual([]);
    });
});

describe("splitChange with a ladder", () => {
    const usdc = universalLadder({ scale: 1n, decimals: 6 });

    const values = (remainder: bigint, maxNotes: number) =>
        splitChange({ pk: 1n, asset: 1n, remainder, maxNotes, ladder: usdc }).map((n) => n.value);

    it("decomposes onto the ladder instead of splitting evenly", () => {
        // An even split would give four off-ladder notes of 1_225_000_000, none withdrawable
        // without re-splitting.
        expect(values(4_900_000_000n, 4)).toEqual([
            2_000_000_000n,
            2_000_000_000n,
            500_000_000n,
            400_000_000n,
        ]);
    });

    it("emits only the notes a short split needs", () => {
        expect(values(1_000_000_000n, 4)).toEqual([1_000_000_000n]);
    });

    it("keeps one ladder piece and the rest as dust under the change cap", () => {
        expect(values(4_900_000_000n, MAX_CHANGE_NOTES)).toEqual([2_000_000_000n, 2_900_000_000n]);
    });

    it("conserves value exactly for any remainder and slot count", () => {
        for (const remainder of [0n, 1n, 4_900_000_000n, 77_777_777n, 123_456_789_012n]) {
            for (const maxNotes of [1, 2, 3, 4]) {
                const out = values(remainder, maxNotes);
                expect(out.length).toBeLessThanOrEqual(maxNotes);
                expect(out.reduce((a, b) => a + b, 0n)).toBe(remainder);
            }
        }
    });

    it("emits at most one off-ladder note", () => {
        for (const remainder of [4_900_000_000n, 77_777_777n, 123_456_789_012n, 999n]) {
            const offLadder = values(remainder, 4).filter((v) => v !== 0n && !usdc.includes(v));
            expect(offLadder.length).toBeLessThanOrEqual(1);
        }
    });

    it("leaves the even split untouched when the asset has no ladder", () => {
        // An asset absent from the denomination table splits evenly.
        expect(
            splitChange({ pk: 1n, asset: 1n, remainder: 7n, maxNotes: 2 }).map((n) => n.value),
        ).toEqual([3n, 4n]);
        expect(
            splitChange({ pk: 1n, asset: 1n, remainder: 7n, maxNotes: 2, ladder: undefined }).map(
                (n) => n.value,
            ),
        ).toEqual([3n, 4n]);
    });
});

describe("splitChange when the wallet opts out", () => {
    it("splits evenly again, exactly as it did before denominations", () => {
        // `WalletConfig.denominations: false` resolves to an empty ladder, which must split evenly;
        // decomposing against it would put the whole remainder into dust.
        const optedOut = splitChange({
            pk: 1n,
            asset: 1n,
            remainder: 4_900_000_000n,
            maxNotes: 4,
            ladder: [],
        });
        expect(optedOut.map((n) => n.value)).toEqual([
            1_225_000_000n,
            1_225_000_000n,
            1_225_000_000n,
            1_225_000_000n,
        ]);
        expect(optedOut.map((n) => n.value)).toEqual(
            splitChange({ pk: 1n, asset: 1n, remainder: 4_900_000_000n, maxNotes: 4 }).map(
                (n) => n.value,
            ),
        );
    });
});

describe("padSlots", () => {
    let J: Jubjub;
    beforeAll(async () => {
        J = await Jubjub.build();
    });

    it("builds value-0 notes of the asset that are not the wallet's", () => {
        const pads = padSlots(J, ASSET, 4);
        expect(pads).toHaveLength(4);
        expect(pads.every((s) => s.note.value === 0n && s.note.asset === ASSET)).toBe(true);
        expect(pads.every((s) => !s.own && !s.payee)).toBe(true);
        expect(padSlots(J, ASSET, 0)).toEqual([]);
    });

    it("draws every pad its own recipient, in the prime-order subgroup", () => {
        const pads = padSlots(J, ASSET, 4);
        for (const { note, recipient } of pads) {
            expect(note.pk).toBe(recipient.pk);
            expect(recipient.oneTime).toBe(true);
            expect(J.inSubgroup(recipient.pk_d)).toBe(true);
            expect(J.inSubgroup(recipient.ck)).toBe(true);
        }
        const distinct = (key: (s: (typeof pads)[number]) => string) => new Set(pads.map(key)).size;
        expect(distinct((s) => String(s.recipient.pk))).toBe(4);
        expect(distinct((s) => String(s.recipient.pk_d))).toBe(4);
        expect(distinct((s) => String(s.recipient.ck))).toBe(4);
    });
});
