import { describe, expect, it } from "vitest";
import type { StoredNote } from "./note-store.js";
import { type SelectOpts, selectNotes } from "./selection.js";

function note(
    id: string,
    value: bigint,
    opts: { asset?: bigint; spent?: boolean; firstSeenBlock?: number } = {},
): StoredNote {
    return {
        id,
        asset: (opts.asset ?? 1n).toString(),
        value: value.toString(),
        rho: "0",
        rcm: "0",
        rcvDep: "0",
        cm: `0x${id.padStart(64, "0")}`,
        leafIndex: parseInt(id, 16) || 0,
        spent: opts.spent ?? false,
        discoveredAt: "1970-01-01T00:00:00Z",
        firstSeenBlock: opts.firstSeenBlock,
    };
}

/** Mulberry32 PRNG. */
function seededRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const baseOpts = (extra: SelectOpts = {}): SelectOpts => ({
    rng: seededRng(1),
    bucketPct: 0, // deterministic: disable shuffle
    ...extra,
});

describe("selectNotes", () => {
    it("throws when no candidates for asset", () => {
        expect(() => selectNotes([], 1n, 100n, baseOpts())).toThrow(/no spendable/);
    });

    it("filters spent notes", () => {
        const notes = [note("a", 100n, { spent: true }), note("b", 200n)];
        const r = selectNotes(notes, 1n, 50n, baseOpts());
        expect(r.plan).toBe("direct");
        if (r.plan === "direct") expect(r.notes.map((n) => n.id)).toEqual(["b"]);
    });

    it("filters by asset", () => {
        const notes = [note("a", 1000n, { asset: 2n }), note("b", 100n, { asset: 1n })];
        const r = selectNotes(notes, 1n, 50n, baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes[0].id).toBe("b");
    });

    it("single-cover prefers smallest sufficient note (not largest)", () => {
        const notes = [note("a", 50n), note("b", 200n), note("c", 1000n), note("d", 5000n)];
        const r = selectNotes(notes, 1n, 100n, baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes).toHaveLength(1);
        expect(r.notes[0].id).toBe("b");
        expect(r.sum).toBe(200n);
    });

    it("respects fee in cover threshold", () => {
        const notes = [note("a", 100n), note("b", 110n)];
        const r = selectNotes(notes, 1n, 100n, baseOpts({ fee: 5n }));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes[0].id).toBe("b");
    });

    it("two-cover picks smallest pair, not largest+gap", () => {
        const notes = [note("a", 30n), note("b", 40n), note("c", 60n), note("d", 1000n)];
        // target 80 → smallest pair (a=30, c=60)=90; large `d` kept for later.
        const r = selectNotes(notes, 1n, 80n, baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        const ids = r.notes.map((n) => n.id).sort();
        expect(ids).toEqual(["a", "c"]);
        expect(r.sum).toBe(90n);
    });

    it("excludes dust below threshold", () => {
        const notes = [note("dust", 1n), note("ok", 200n)];
        const r = selectNotes(notes, 1n, 100n, baseOpts({ dustThreshold: 10n }));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes[0].id).toBe("ok");
    });

    it("includes dust when dustThreshold=0", () => {
        const notes = [note("a", 50n), note("b", 50n)];
        const r = selectNotes(notes, 1n, 100n, baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes).toHaveLength(2);
    });

    it("skips notes still in cooldown window", () => {
        const notes = [
            note("fresh", 1000n, { firstSeenBlock: 99 }),
            note("ripe", 200n, { firstSeenBlock: 50 }),
        ];
        const r = selectNotes(
            notes,
            1n,
            100n,
            baseOpts({
                cooldownBlocks: 2,
                tipBlock: 100,
            }),
        );
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes[0].id).toBe("ripe");
    });

    it("ignores cooldown when firstSeenBlock missing", () => {
        const notes = [note("a", 200n)];
        const r = selectNotes(
            notes,
            1n,
            100n,
            baseOpts({
                cooldownBlocks: 5,
                tipBlock: 100,
            }),
        );
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes[0].id).toBe("a");
    });

    it("returns consolidate-first when sum sufficient but no 2-cover", () => {
        // max pair=90, total=120, target=100 → consolidate.
        const notes = [note("a", 30n), note("b", 40n), note("c", 50n)];
        const r = selectNotes(notes, 1n, 100n, baseOpts());
        expect(r.plan).toBe("consolidate-first");
        if (r.plan === "consolidate-first") {
            expect(r.consolidate.map((n) => n.id).sort()).toEqual(["a", "b"]);
            expect(r.consolidateSum).toBe(70n);
            expect(r.targetWithFee).toBe(100n);
        }
    });

    it("throws when total funds < target", () => {
        const notes = [note("a", 10n), note("b", 20n)];
        expect(() => selectNotes(notes, 1n, 1000n, baseOpts())).toThrow(/insufficient/);
    });

    it("bucket shuffle: ±5% bucket randomizes among near-equal notes", () => {
        const notes = [note("a", 100n), note("b", 102n), note("c", 98n)];
        const picks = new Set<string>();
        for (let s = 1; s < 200; s++) {
            const r = selectNotes(notes, 1n, 90n, { rng: seededRng(s), bucketPct: 0.05 });
            if (r.plan === "direct") picks.add(r.notes[0].id);
        }
        expect(picks.size).toBeGreaterThan(1);
    });

    it("privacy regression: no monotone preference for largest-rank notes", () => {
        // Random wallets: picked-note rank should not correlate with wallet size.
        const samples: number[] = [];
        const rng = seededRng(42);
        for (let trial = 0; trial < 100; trial++) {
            const n = 5 + Math.floor(rng() * 10);
            const values: bigint[] = [];
            for (let i = 0; i < n; i++) values.push(BigInt(50 + Math.floor(rng() * 500)));
            const notes = values.map((v, i) => note(i.toString(16), v));
            const target = BigInt(50 + Math.floor(rng() * 200));
            const r = selectNotes(notes, 1n, target, { rng, bucketPct: 0.05 });
            if (r.plan !== "direct") continue;
            const ascValues = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
            const picked = BigInt(r.notes[0].value);
            const rank = ascValues.indexOf(picked) / Math.max(1, n - 1);
            samples.push(rank);
        }
        const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
        // largest-first ⇒ rank≈1; SFRT should land in lower half.
        expect(mean).toBeLessThan(0.5);
    });
});
