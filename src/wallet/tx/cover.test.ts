import { describe, expect, it, vi } from "vitest";
import { assetId, circuitAmount } from "../../core/brand.js";
import { InsufficientCoverError, NotesHeldError } from "../../errors/funds.js";
import { storedNote } from "../../test-utils/wallet.js";
import { NoteLeases } from "../notes/leases.js";
import type { StoredNote } from "../notes/note-store.js";
import type { CoinSelector, SelectionResult, SelectOpts } from "../selection/index.js";
import { selectNotes } from "../selection/index.js";
import { ensureCover } from "./cover.js";

const ASSET = assetId(1n);
const real: CoinSelector = { select: selectNotes };

/// A selector returning a scripted plan per call, for the control-flow cases.
function scripted(plans: SelectionResult[]): CoinSelector {
    let i = 0;
    return {
        select: () => plans[Math.min(i++, plans.length - 1)]!,
    };
}

const consolidateFirst = (notes: StoredNote[], target: bigint): SelectionResult => ({
    plan: "consolidate-first",
    consolidate: notes,
    consolidateSum: circuitAmount(notes.reduce((a, n) => a + BigInt(n.value), 0n)),
    targetWithFee: circuitAmount(target),
});

describe("ensureCover", () => {
    it("returns a direct selection without consolidating", async () => {
        const notes = [storedNote("01", 100n)];
        const consolidate = vi.fn(async () => undefined);
        const sel = await ensureCover(
            real,
            () => notes,
            {
                asset: ASSET,
                target: circuitAmount(50n),
                selectOpts: async () => ({ maxInputs: 4 }),
            },
            consolidate,
        );
        expect(sel.plan).toBe("direct");
        expect(consolidate).not.toHaveBeenCalled();
    });

    it("throws without consolidating when not asked to", async () => {
        const notes = [storedNote("01", 10n), storedNote("02", 20n)];
        const consolidate = vi.fn(async () => undefined);
        const err = await ensureCover(
            real,
            () => notes,
            {
                asset: ASSET,
                target: circuitAmount(25n),
                selectOpts: async () => ({ maxInputs: 1 }),
            },
            consolidate,
        ).catch((e) => e);

        expect(err).toBeInstanceOf(InsufficientCoverError);
        expect(err.consolidationAttempted).toBe(false);
        expect(consolidate).not.toHaveBeenCalled();
    });

    it("marks the error when consolidation ran and still did not help", async () => {
        // Lets a UI avoid suggesting `autoConsolidate` when it was already set.
        const notes = [storedNote("01", 10n), storedNote("02", 20n)];
        const target = circuitAmount(25n);
        const err = await ensureCover(
            scripted([
                consolidateFirst(notes, 25n),
                consolidateFirst([storedNote("03", 30n)], 25n),
            ]),
            () => notes,
            {
                asset: ASSET,
                target,
                autoConsolidate: true,
                selectOpts: async () => ({ maxInputs: 1 }),
            },
            async () => undefined,
        ).catch((e) => e);

        expect(err).toBeInstanceOf(InsufficientCoverError);
        expect(err.consolidationAttempted).toBe(true);
        expect(err.message).toMatch(/after consolidating/);
    });

    it("re-reads the selection options on every attempt", async () => {
        // The merged note is younger than the first attempt's tip, so a captured
        // `tipBlock` would exclude it from the retry via the cooldown rule.
        // Two aged notes that together cover the target but individually do not,
        // at `maxInputs: 1`, which yields `consolidate-first`.
        let notes = [
            storedNote("01", 10n, { firstSeenBlock: 90 }),
            storedNote("02", 45n, { firstSeenBlock: 90 }),
        ];
        let tip = 100;
        const merged = storedNote("03", 55n, { firstSeenBlock: 101 });

        const opts = vi.fn(async (): Promise<SelectOpts> => ({ maxInputs: 1, tipBlock: tip }));
        const sel = await ensureCover(
            real,
            () => notes,
            { asset: ASSET, target: circuitAmount(50n), autoConsolidate: true, selectOpts: opts },
            async () => {
                // Simulated consolidation: inputs are consumed, one merged note
                // lands at block 101, and `awaitCooldown` waits for the tip to
                // pass it.
                notes = [merged];
                tip = 102;
            },
        );

        expect(sel.plan).toBe("direct");
        expect(sel.notes.map((n) => n.id)).toEqual(["03"]);
        // Once before consolidating and once after; reusing tip 100 would exclude
        // `merged` (first seen at block 101) under the cooldown rule.
        expect(opts).toHaveBeenCalledTimes(2);
    });

    it("consolidates more than once when a single merge is not enough", async () => {
        const consolidate = vi.fn(async () => undefined);
        const err = await ensureCover(
            scripted([
                consolidateFirst([storedNote("01", 1n)], 99n),
                consolidateFirst([storedNote("02", 2n)], 99n),
                consolidateFirst([storedNote("03", 3n)], 99n),
                consolidateFirst([storedNote("04", 4n)], 99n),
            ]),
            () => [],
            {
                asset: ASSET,
                target: circuitAmount(99n),
                autoConsolidate: true,
                selectOpts: async () => ({ maxInputs: 4 }),
            },
            consolidate,
        ).catch((e) => e);

        expect(err).toBeInstanceOf(InsufficientCoverError);
        // Exactly MAX_ROUNDS; an exact count pins the cap.
        expect(consolidate).toHaveBeenCalledTimes(3);
    });

    it("stops as soon as a round changes nothing", async () => {
        // A consolidation that makes no progress must not run to the round cap.
        const same = consolidateFirst([storedNote("01", 1n), storedNote("02", 2n)], 99n);
        const consolidate = vi.fn(async () => undefined);
        const err = await ensureCover(
            scripted([same]),
            () => [],
            {
                asset: ASSET,
                target: circuitAmount(99n),
                autoConsolidate: true,
                selectOpts: async () => ({ maxInputs: 4 }),
            },
            consolidate,
        ).catch((e) => e);

        expect(err).toBeInstanceOf(InsufficientCoverError);
        expect(consolidate).toHaveBeenCalledTimes(1);
    });
});

// A spend losing a race with a concurrent one sees only the notes no lease holds.
// Its error must say the notes are busy, not that the balance is short.
describe("ensureCover with in-flight leases", () => {
    it("reports leased notes as held, retryably", async () => {
        const notes = [storedNote("01", 100n), storedNote("02", 100n)];
        const leases = new NoteLeases();
        leases.lease(["01", "02"]);

        const err = await ensureCover(
            real,
            () => notes,
            {
                asset: ASSET,
                target: circuitAmount(150n),
                selectOpts: async () => ({ maxInputs: 4 }),
            },
            vi.fn(async () => undefined),
            leases,
        ).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(NotesHeldError);
        expect(err).toMatchObject({
            code: "NOTES_HELD",
            retryable: true,
            spendable: 0n,
            required: 150n,
            held: { reserved: { value: 200n, count: 2 } },
        });
        // No persisted reservation: only a running spend holds them.
        expect((err as NotesHeldError).reservedUntil).toBeUndefined();
    });

    it("still reports a short balance when the leased notes would not cover it either", async () => {
        const notes = [storedNote("01", 10n), storedNote("02", 20n)];
        const leases = new NoteLeases();
        leases.lease(["01"]);

        await expect(
            ensureCover(
                real,
                () => notes,
                { asset: ASSET, target: circuitAmount(100n) },
                vi.fn(async () => undefined),
                leases,
            ),
        ).rejects.toMatchObject({ code: "INSUFFICIENT_BALANCE", available: 30n, required: 100n });
    });
});
