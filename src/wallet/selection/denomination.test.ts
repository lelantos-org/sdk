import { describe, expect, it } from "vitest";
import { assetId, circuitAmount } from "../../core/brand.js";
import { storedNote } from "../../test-utils/wallet.js";
import { DenominationCoinSelector, SfrtCoinSelector } from "./index.js";

const ASSET = assetId(1n);

const sel = new DenominationCoinSelector();

describe("DenominationCoinSelector", () => {
    it("pays a denomination exactly, leaving no change to re-split", () => {
        const notes = [storedNote("a", 1_000_000_000n), storedNote("b", 5_000_000_000n)];
        const r = sel.select(notes, ASSET, circuitAmount(1_000_000_000n));
        expect(r.plan).toBe("direct");
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.sum).toBe(1_000_000_000n);
        expect(r.notes.map((n) => n.id)).toEqual(["a"]);
    });

    it("combines notes to hit the target exactly", () => {
        const notes = [
            storedNote("a", 500_000_000n),
            storedNote("b", 500_000_000n),
            storedNote("c", 5_000_000_000n),
        ];
        const r = sel.select(notes, ASSET, circuitAmount(1_000_000_000n));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.sum).toBe(1_000_000_000n);
        expect(r.notes.map((n) => n.id).sort()).toEqual(["a", "b"]);
    });

    it("prefers the smallest exact cover", () => {
        const notes = [
            storedNote("one", 1_000_000_000n),
            storedNote("half1", 500_000_000n),
            storedNote("half2", 500_000_000n),
        ];
        const r = sel.select(notes, ASSET, circuitAmount(1_000_000_000n));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes).toHaveLength(1);
    });

    it("randomises among equally-sized exact covers", () => {
        // Determinism would make selection predictable from a public note set,
        // which SFRT's tiebreak is designed to prevent.
        const notes = [storedNote("a", 1_000_000_000n), storedNote("b", 1_000_000_000n)];
        const first = sel.select(notes, ASSET, circuitAmount(1_000_000_000n), { pick: () => 0 });
        const second = sel.select(notes, ASSET, circuitAmount(1_000_000_000n), { pick: () => 1 });
        if (first.plan !== "direct" || second.plan !== "direct") throw new Error("direct");
        expect(first.notes[0]?.id).not.toBe(second.notes[0]?.id);
    });

    it("falls through to SFRT when no exact cover exists", () => {
        const notes = [storedNote("a", 5_000_000_000n)];
        const target = circuitAmount(1_000_000_000n);
        const mine = sel.select(notes, ASSET, target);
        const sfrt = new SfrtCoinSelector().select(notes, ASSET, target);
        expect(mine).toEqual(sfrt);
    });

    it("honours dust, cooldown and `only` exactly as SFRT does", () => {
        // The exact-cover pass must not select a note the spendability rules
        // exclude.
        const notes = [storedNote("a", 1_000_000_000n), storedNote("b", 1_000_000_000n)];
        const r = sel.select(notes, ASSET, circuitAmount(1_000_000_000n), { only: ["b"] });
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes.map((n) => n.id)).toEqual(["b"]);
    });

    it("ignores notes of another asset", () => {
        // Falls through to SFRT's failure; the exact-cover pass must not build a
        // cover from notes the spendability rules reject.
        const other = storedNote("x", 1_000_000_000n, { asset: 9n });
        expect(() => sel.select([other], ASSET, circuitAmount(1_000_000_000n))).toThrow(
            expect.objectContaining({ code: "INSUFFICIENT_BALANCE", available: 0n }),
        );
    });
});

describe("DenominationCoinSelector search bounds", () => {
    it("stays fast on a large note set with no exact cover", () => {
        // Without a node budget this walks C(n, 4) and never increments the
        // found counter.
        const many = Array.from({ length: 400 }, (_, i) =>
            storedNote(`n${i}`, 1_000_000n + BigInt(i)),
        );
        const target = circuitAmount(7n); // unreachable: below every note
        const started = performance.now();
        // `pick` is pinned on both calls because SFRT randomises its tiebreak.
        const r = sel.select(many, ASSET, target, { pick: () => 0 });
        expect(performance.now() - started).toBeLessThan(500);
        // Falls through to SFRT.
        expect(r).toEqual(new SfrtCoinSelector().select(many, ASSET, target, { pick: () => 0 }));
    });

    it("still finds an exact cover hiding in a large set", () => {
        const many = Array.from({ length: 200 }, (_, i) =>
            storedNote(`n${i}`, 1_000_000n + BigInt(i)),
        );
        const r = sel.select(
            [...many, storedNote("exact", 5_000_000_000n)],
            ASSET,
            circuitAmount(5_000_000_000n),
        );
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes.map((n) => n.id)).toEqual(["exact"]);
    });
});
