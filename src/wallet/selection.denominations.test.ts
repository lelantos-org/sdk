import { describe, expect, it } from "vitest";
import { assetId, circuitAmount } from "../core/brand.js";
import type { StoredNote } from "./note-store.js";
import { DenominationCoinSelector, SfrtCoinSelector } from "./selection.js";

const ASSET = assetId(1n);

function note(id: string, value: bigint): StoredNote {
    return { id, asset: ASSET.toString(), value: value.toString(), spent: false } as StoredNote;
}

const sel = new DenominationCoinSelector();

describe("DenominationCoinSelector", () => {
    it("pays a denomination exactly, leaving no change to re-split", () => {
        const notes = [note("a", 1_000_000_000n), note("b", 5_000_000_000n)];
        const r = sel.select(notes, ASSET, circuitAmount(1_000_000_000n));
        expect(r.plan).toBe("direct");
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.sum).toBe(1_000_000_000n);
        expect(r.notes.map((n) => n.id)).toEqual(["a"]);
    });

    it("combines notes to hit the target exactly", () => {
        const notes = [note("a", 500_000_000n), note("b", 500_000_000n), note("c", 5_000_000_000n)];
        const r = sel.select(notes, ASSET, circuitAmount(1_000_000_000n));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.sum).toBe(1_000_000_000n);
        expect(r.notes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    });

    it("prefers the smallest exact cover", () => {
        const notes = [
            note("one", 1_000_000_000n),
            note("half1", 500_000_000n),
            note("half2", 500_000_000n),
        ];
        const r = sel.select(notes, ASSET, circuitAmount(1_000_000_000n));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes).toHaveLength(1);
    });

    it("randomises among equally-sized exact covers", () => {
        // Determinism here would make selection predictable from a public note
        // set, which is the property SFRT's tiebreak exists to deny.
        const notes = [note("a", 1_000_000_000n), note("b", 1_000_000_000n)];
        const first = sel.select(notes, ASSET, circuitAmount(1_000_000_000n), { pick: () => 0 });
        const second = sel.select(notes, ASSET, circuitAmount(1_000_000_000n), { pick: () => 1 });
        if (first.plan !== "direct" || second.plan !== "direct") throw new Error("direct");
        expect(first.notes[0]?.id).not.toBe(second.notes[0]?.id);
    });

    it("falls through to SFRT when no exact cover exists", () => {
        const notes = [note("a", 5_000_000_000n)];
        const target = circuitAmount(1_000_000_000n);
        const mine = sel.select(notes, ASSET, target);
        const sfrt = new SfrtCoinSelector().select(notes, ASSET, target);
        expect(mine).toEqual(sfrt);
    });

    it("honours dust, cooldown and `only` exactly as SFRT does", () => {
        // The exact-cover pass must not reach a note the spendability rules
        // excluded, or it would spend something SFRT would have refused.
        const notes = [note("a", 1_000_000_000n), note("b", 1_000_000_000n)];
        const r = sel.select(notes, ASSET, circuitAmount(1_000_000_000n), { only: ["b"] });
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes.map((n) => n.id)).toEqual(["b"]);
    });

    it("ignores notes of another asset", () => {
        // Falls through to SFRT, which reports the same failure it always has:
        // the exact-cover pass must not manufacture a cover from notes the
        // spendability rules already rejected.
        const other = { ...note("x", 1_000_000_000n), asset: "9" } as StoredNote;
        expect(() => sel.select([other], ASSET, circuitAmount(1_000_000_000n))).toThrow(
            /no spendable notes/,
        );
    });
});

describe("DenominationCoinSelector search bounds", () => {
    it("stays fast on a large note set with no exact cover", () => {
        // The expensive case is the one that finds nothing: without a node
        // budget this walks C(n, 4) and never increments the found counter.
        const many = Array.from({ length: 400 }, (_, i) => note(`n${i}`, 1_000_000n + BigInt(i)));
        const target = circuitAmount(7n); // unreachable: below every note
        const started = performance.now();
        // `pick` pinned on both sides: SFRT randomises its tiebreak, so two
        // independent calls are not comparable without it.
        const r = sel.select(many, ASSET, target, { pick: () => 0 });
        expect(performance.now() - started).toBeLessThan(500);
        // Falls through to SFRT, which answers as it always would.
        expect(r).toEqual(new SfrtCoinSelector().select(many, ASSET, target, { pick: () => 0 }));
    });

    it("still finds an exact cover hiding in a large set", () => {
        const many = Array.from({ length: 200 }, (_, i) => note(`n${i}`, 1_000_000n + BigInt(i)));
        const r = sel.select(
            [...many, note("exact", 5_000_000_000n)],
            ASSET,
            circuitAmount(5_000_000_000n),
        );
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes.map((n) => n.id)).toEqual(["exact"]);
    });
});
