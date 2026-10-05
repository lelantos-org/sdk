import { beforeAll, describe, expect, it } from "vitest";
import { sealOutput } from "../../bundle/common.js";
import { BN254_FR } from "../../core/field.js";
import { randomBytes, randomFr } from "../../core/random.js";
import { Jubjub } from "../../crypto/jubjub.js";
import { Poseidon } from "../../crypto/poseidon.js";
import type { DecodedAddress } from "../../keys/address.js";
import { universalLadder } from "../../protocol/denominations.js";
import { freshAccount, recipientAt } from "../../test-utils/outputs.js";
import {
    changeSlots,
    finalizeSlots,
    MAX_CHANGE_NOTES,
    type OutputSlotSpec,
    padRecipient,
    padSlots,
    splitChange,
} from "./outputs.js";

// Change notes sum to the remainder exactly, and a two-note split yields `[floor(r/2), ceil(r/2)]`.

const ASSET = 1n;
const values = (remainder: bigint, maxNotes: number) => splitChange({ remainder, maxNotes });

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

    it("rejects a split into no notes", () => {
        expect(() => splitChange({ remainder: 10n, maxNotes: 0 })).toThrow(/at least one note/);
    });
});

const OWN = { pk: 7n } as unknown as DecodedAddress;

/** 10 units of change to self, in at most `maxNotes` slots. */
const ownChange = (maxNotes: number) =>
    changeSlots({ ownAddr: OWN, asset: ASSET, remainder: 10n, maxNotes });

describe("changeSlots", () => {
    it("addresses every slot back to self, in the asset", () => {
        const slots = ownChange(3);
        expect(slots).toHaveLength(3);
        expect(slots.every((s) => s.own)).toBe(true);
        expect(slots.every((s) => s.recipient === OWN && s.asset === ASSET)).toBe(true);
        expect(slots.reduce((a, s) => a + s.value, 0n)).toBe(10n);
    });
});

// `finalizeSlots` shuffles, so the outputs, `ownIndices` and `payeeIndex` must all describe the same
// permutation. `pick` lets a test pin the permutation.

const THEIRS = { pk: 99n } as unknown as DecodedAddress;

/** A slot paying `value` to someone else. */
const toThem = (value: bigint): OutputSlotSpec => ({
    asset: ASSET,
    value,
    recipient: THEIRS,
    own: false,
});

/** `pick` replaying a fixed queue of draws. */
const pinned = (draws: number[]) => {
    let i = 0;
    return () => draws[i++]!;
};

/** [ours, ours, theirs] — two change slots and a relayer's fee note. */
const changeAndFee = () => {
    const mine = ownChange(2);
    return [mine[0]!, mine[1]!, toThem(3n)];
};

describe("finalizeSlots", () => {
    it("moves value, recipient and ownership together", () => {
        // pick(3) = 0 then pick(2) = 0 swaps 2<->0 and then 1<->0, taking [ours, ours, theirs] to
        // [ours, theirs, ours].
        const slots = changeAndFee();
        const { outputs, ownIndices } = finalizeSlots(slots, pinned([0, 0]));

        expect(outputs).toEqual([
            { asset: ASSET, value: slots[1]!.value, recipient: OWN },
            { asset: ASSET, value: 3n, recipient: THEIRS },
            { asset: ASSET, value: slots[0]!.value, recipient: OWN },
        ]);
        expect(ownIndices).toEqual([0, 2]);
    });

    it("keeps each slot's value with its recipient under any permutation", () => {
        // A fee value sealed to another slot's recipient balances and proves but pays the relayer
        // nothing.
        for (let i = 0; i < 50; i++) {
            const { outputs, ownIndices } = finalizeSlots(changeAndFee());
            for (const [j, out] of outputs.entries()) {
                expect(out.recipient).toBe(out.value === 3n ? THEIRS : OWN);
                expect(ownIndices.includes(j)).toBe(out.recipient === OWN);
            }
        }
    });

    it("hands buildSpend the output alone, without the wallet's bookkeeping", () => {
        const { outputs } = finalizeSlots([{ ...toThem(3n), payee: true }]);
        expect(outputs).toEqual([{ asset: ASSET, value: 3n, recipient: THEIRS }]);
        expect(Object.keys(outputs[0]!).sort()).toEqual(["asset", "recipient", "value"]);
    });

    it("puts the fee anywhere, not last", () => {
        const seen = new Set<number>();
        for (let i = 0; i < 200; i++) {
            seen.add(
                finalizeSlots(changeAndFee()).outputs.findIndex((o) => o.recipient === THEIRS),
            );
        }
        expect([...seen].sort()).toEqual([0, 1, 2]);
    });

    it("reports where the payee's slot landed, and omits it when there is none", () => {
        const mine = ownChange(1);
        const payee = { ...toThem(10n), payee: true };
        // pick(2) = 0 swaps 1<->0, so the payee moves off slot 0.
        expect(finalizeSlots([payee, mine[0]!], pinned([0])).payeeIndex).toBe(1);
        expect(finalizeSlots(mine).payeeIndex).toBeUndefined();
    });

    it("is empty when nothing is ours", () => {
        const mine = ownChange(1);
        expect(finalizeSlots([{ ...mine[0]!, own: false }]).ownIndices).toEqual([]);
    });
});

describe("splitChange with a ladder", () => {
    const usdc = universalLadder({ scale: 1n, decimals: 6 });

    const values = (remainder: bigint, maxNotes: number) =>
        splitChange({ remainder, maxNotes, ladder: usdc });

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
        expect(splitChange({ remainder: 7n, maxNotes: 2 })).toEqual([3n, 4n]);
        expect(splitChange({ remainder: 7n, maxNotes: 2, ladder: undefined })).toEqual([3n, 4n]);
    });
});

describe("splitChange when the wallet opts out", () => {
    it("splits evenly again, exactly as it did before denominations", () => {
        // `WalletConfig.denominations: false` resolves to an empty ladder, which must split evenly;
        // decomposing against it would put the whole remainder into dust.
        const optedOut = splitChange({ remainder: 4_900_000_000n, maxNotes: 4, ladder: [] });
        expect(optedOut).toEqual([1_225_000_000n, 1_225_000_000n, 1_225_000_000n, 1_225_000_000n]);
        expect(optedOut).toEqual(splitChange({ remainder: 4_900_000_000n, maxNotes: 4 }));
    });
});

describe("padSlots", () => {
    let J: Jubjub;
    let P: Poseidon;
    beforeAll(async () => {
        J = await Jubjub.build();
        P = await Poseidon.build();
    });

    it("builds value-0 outputs of the asset that are not the wallet's", () => {
        const pads = padSlots(J, ASSET, 4);
        expect(pads).toHaveLength(4);
        expect(pads.every((s) => s.value === 0n && s.asset === ASSET)).toBe(true);
        expect(pads.every((s) => !s.own && !s.payee)).toBe(true);
        expect(padSlots(J, ASSET, 0)).toEqual([]);
    });

    it("draws every pad its own address: diversifier, pk, and two subgroup points", () => {
        const pads = padSlots(J, ASSET, 4);
        const isIdentity = (p: readonly [bigint, bigint]) => p[0] === 0n && p[1] === 1n;
        for (const { recipient } of pads) {
            // Never cached: no later output is sealed to it.
            expect(recipient.oneTime).toBe(true);
            expect(recipient.d >= 0n && recipient.d < 1n << 128n).toBe(true);
            expect(recipient.pk > 0n && recipient.pk < BN254_FR).toBe(true);
            for (const point of [recipient.pk_d, recipient.ck_d]) {
                expect(J.inSubgroup(point)).toBe(true);
                expect(isIdentity(point)).toBe(false);
            }
        }
        const distinct = (key: (s: (typeof pads)[number]) => string) => new Set(pads.map(key)).size;
        expect(distinct((s) => String(s.recipient.d))).toBe(4);
        expect(distinct((s) => String(s.recipient.pk))).toBe(4);
        expect(distinct((s) => String(s.recipient.pk_d))).toBe(4);
        expect(distinct((s) => String(s.recipient.ck_d))).toBe(4);
    });

    it("draws one address per call, marked one-time", () => {
        const [a, b] = [padRecipient(J), padRecipient(J)];
        expect(a.oneTime && b.oneTime).toBe(true);
        for (const part of ["d", "pk", "pk_d", "ck_d"] as const) {
            expect(String(a[part])).not.toBe(String(b[part]));
        }
        expect(J.inSubgroup(a.pk_d) && J.inSubgroup(a.ck_d)).toBe(true);
    });

    // On chain a pad must read as a paying output: both go through `sealOutput`, and what it
    // publishes for a pad has the form it publishes for a real address.
    it("seals like a paying output, on the base its diversifier selects", () => {
        const [pad] = padSlots(J, ASSET, 1);
        const real = recipientAt(P, J, freshAccount(P, J).keys);
        const o = {
            outgoingKey: randomBytes(32),
            chainId: 31337n,
            rho: randomFr(),
            nullifiers: [randomFr(), randomFr()],
        };

        const sealedPad = sealOutput(J, P, {
            ...o,
            asset: ASSET,
            value: 0n,
            recipient: pad!.recipient,
        });
        const sealedReal = sealOutput(J, P, { ...o, asset: ASSET, value: 5n, recipient: real });

        for (const { aux } of [sealedPad.aux, sealedReal.aux]) {
            for (const point of [aux.clueR, aux.clueQ, aux.ephPub]) {
                expect(J.inSubgroup(point)).toBe(true);
            }
        }
        // Same wire length: 2 B clue bits, 96 B plaintext, 16 B tag.
        expect(sealedPad.aux.aux.ciphertext).toHaveLength(114);
        expect(sealedReal.aux.aux.ciphertext).toHaveLength(114);
        expect(sealedPad.note).toMatchObject({ value: 0n, pk: pad!.recipient.pk, rho: o.rho });
    });
});
