import { describe, expect, it, vi } from "vitest";
import { assetId, circuitAmount } from "../core/brand.js";
import { InsufficientCoverError } from "../core/errors.js";
import { ensureCover } from "./cover.js";
import type { StoredNote } from "./note-store.js";
import type { CoinSelector, SelectionResult, SelectOpts } from "./selection.js";
import { selectNotes } from "./selection.js";
import { storedNote } from "./wallet-test-utils.js";

const note = (id: string, value: bigint, firstSeenBlock?: number): StoredNote =>
    storedNote(id, value, firstSeenBlock === undefined ? {} : { firstSeenBlock });

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
        const notes = [note("01", 100n)];
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
        const notes = [note("01", 10n), note("02", 20n)];
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
        // The distinction a UI needs: telling the user to pass a flag they
        // already passed is what the single-message version did.
        const notes = [note("01", 10n), note("02", 20n)];
        const target = circuitAmount(25n);
        const err = await ensureCover(
            scripted([consolidateFirst(notes, 25n), consolidateFirst([note("03", 30n)], 25n)]),
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
        // The regression this file exists for. `tipBlock` was read once and
        // captured; the note consolidation creates is younger than that tip, so
        // the cooldown rule excluded the note from its own retry — every time,
        // not as a race. Options must be rebuilt per round.
        // Two aged notes that together clear the target but individually do
        // not, at `maxInputs: 1` — the shape that yields `consolidate-first`.
        let notes = [note("01", 10n, 90), note("02", 45n, 90)];
        let tip = 100;
        const merged = note("03", 55n, 101);

        const opts = vi.fn(async (): Promise<SelectOpts> => ({ maxInputs: 1, tipBlock: tip }));
        const sel = await ensureCover(
            real,
            () => notes,
            { asset: ASSET, target: circuitAmount(50n), autoConsolidate: true, selectOpts: opts },
            async () => {
                // What consolidation does: the inputs are gone, one merged note
                // lands at block 101, and `awaitCooldown` waits for the tip to
                // move past it.
                notes = [merged];
                tip = 102;
            },
        );

        expect(sel.plan).toBe("direct");
        expect(sel.notes.map((n) => n.id)).toEqual(["03"]);
        // Twice: once before consolidating, once after. Captured once instead,
        // the retry would have re-used tip 100 — and `merged`, first seen at
        // block 101, is *younger than that tip*, so the cooldown rule would
        // have excluded the very note consolidation had just created.
        expect(opts).toHaveBeenCalledTimes(2);
    });

    it("consolidates more than once when a single merge is not enough", async () => {
        const consolidate = vi.fn(async () => undefined);
        const err = await ensureCover(
            scripted([
                consolidateFirst([note("01", 1n)], 99n),
                consolidateFirst([note("02", 2n)], 99n),
                consolidateFirst([note("03", 3n)], 99n),
                consolidateFirst([note("04", 4n)], 99n),
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
        // Exactly MAX_ROUNDS. A range would still pass if the cap silently
        // dropped, which is the constant this case exists to pin.
        expect(consolidate).toHaveBeenCalledTimes(3);
    });

    it("stops as soon as a round changes nothing", async () => {
        // A consolidation that silently no-ops must not spin to the round cap.
        const same = consolidateFirst([note("01", 1n), note("02", 2n)], 99n);
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
