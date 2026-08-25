import { describe, expect, it } from "vitest";
import { assetId, circuitAmount } from "../core/brand.js";
import { randomBelow } from "../core/random.js";
import { SPEND_RESERVATION_MS } from "./constants.js";
import type { StoredNote } from "./note-store.js";
import { type SelectOpts, selectNotes } from "./selection.js";

function note(
    id: string,
    value: bigint,
    opts: {
        asset?: bigint;
        spent?: boolean;
        firstSeenBlock?: number;
        pendingSpendAt?: string;
    } = {},
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
        pendingSpendAt: opts.pendingSpendAt,
    };
}

const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

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

/**
 * A seeded `SelectOpts.pick`, driving the real {@link randomBelow} off a seeded
 * byte stream rather than reimplementing its rejection sampling — so a test
 * exercises the same index derivation production does.
 */
function seededPick(seed: number): (n: number) => number {
    const r = seededRng(seed);
    const bytes = (k: number) => Uint8Array.from({ length: k }, () => Math.floor(r() * 256));
    return (n) => randomBelow(n, bytes);
}

const baseOpts = (extra: SelectOpts = {}): SelectOpts => ({
    pick: seededPick(1),
    bucketPct: 0, // deterministic: disable shuffle
    ...extra,
});

describe("selectNotes", () => {
    it("throws when no candidates for asset", () => {
        expect(() => selectNotes([], assetId(1n), circuitAmount(100n), baseOpts())).toThrow(
            /no spendable/,
        );
    });

    it("filters spent notes", () => {
        const notes = [note("a", 100n, { spent: true }), note("b", 200n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(50n), baseOpts());
        expect(r.plan).toBe("direct");
        if (r.plan === "direct") expect(r.notes.map((n) => n.id)).toEqual(["b"]);
    });

    it("filters by asset", () => {
        const notes = [note("a", 1000n, { asset: 2n }), note("b", 100n, { asset: 1n })];
        const r = selectNotes(notes, assetId(1n), circuitAmount(50n), baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes[0]!.id).toBe("b");
    });

    it("single-cover prefers smallest sufficient note (not largest)", () => {
        const notes = [note("a", 50n), note("b", 200n), note("c", 1000n), note("d", 5000n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(100n), baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes).toHaveLength(1);
        expect(r.notes[0]!.id).toBe("b");
        expect(r.sum).toBe(200n);
    });

    it("respects fee in cover threshold", () => {
        const notes = [note("a", 100n), note("b", 110n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(100n), baseOpts({ fee: 5n }));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes[0]!.id).toBe("b");
    });

    it("two-cover picks smallest pair, not largest+gap", () => {
        const notes = [note("a", 30n), note("b", 40n), note("c", 60n), note("d", 1000n)];
        // target 80 → smallest pair (a=30, c=60)=90; large `d` kept for later.
        const r = selectNotes(notes, assetId(1n), circuitAmount(80n), baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        const ids = r.notes.map((n) => n.id).sort();
        expect(ids).toEqual(["a", "c"]);
        expect(r.sum).toBe(90n);
    });

    it("excludes dust below threshold", () => {
        const notes = [note("dust", 1n), note("ok", 200n)];
        const r = selectNotes(
            notes,
            assetId(1n),
            circuitAmount(100n),
            baseOpts({ dustThreshold: 10n }),
        );
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes[0]!.id).toBe("ok");
    });

    it("includes dust when dustThreshold=0", () => {
        const notes = [note("a", 50n), note("b", 50n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(100n), baseOpts());
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
            assetId(1n),
            circuitAmount(100n),
            baseOpts({
                cooldownBlocks: 2,
                tipBlock: 100,
            }),
        );
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes[0]!.id).toBe("ripe");
    });

    it("holds back a note first seen at the tip, by default", () => {
        // The default cooldown breaks the same-block change-link heuristic.
        const notes = [note("a", 200n, { firstSeenBlock: 100 })];

        expect(() =>
            selectNotes(notes, assetId(1n), circuitAmount(100n), { tipBlock: 100 }),
        ).toThrow(/1 in spend cooldown/);
        expect(selectNotes(notes, assetId(1n), circuitAmount(100n), { tipBlock: 101 }).plan).toBe(
            "direct",
        );
        // An explicit 0 still opts out.
        expect(
            selectNotes(notes, assetId(1n), circuitAmount(100n), {
                tipBlock: 100,
                cooldownBlocks: 0,
            }).plan,
        ).toBe("direct");
    });

    it("names which rule emptied the candidate set", () => {
        // "no spendable notes" alone cannot distinguish an empty wallet from a
        // wrong-asset one, or from a cooldown holding every note back.
        const notes = [
            note("spent", 500n, { spent: true }),
            note("other", 500n, { asset: 2n }),
            note("dusty", 1n),
        ];
        expect(() =>
            selectNotes(notes, assetId(1n), circuitAmount(100n), { dustThreshold: 10n }),
        ).toThrow(/3 in store: 1 spent, 1 other asset, 1 below dust threshold/);
    });

    it("ignores cooldown when firstSeenBlock missing", () => {
        const notes = [note("a", 200n)];
        const r = selectNotes(
            notes,
            assetId(1n),
            circuitAmount(100n),
            baseOpts({
                cooldownBlocks: 5,
                tipBlock: 100,
            }),
        );
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes[0]!.id).toBe("a");
    });

    it("returns consolidate-first when sum sufficient but no 2-cover", () => {
        // max pair=90, total=120, target=100 → consolidate. Pinned to two
        // inputs: at the default 4×4 arity, 30+40+50 covers 100 directly.
        const notes = [note("a", 30n), note("b", 40n), note("c", 50n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(100n), baseOpts({ maxInputs: 2 }));
        expect(r.plan).toBe("consolidate-first");
        if (r.plan === "consolidate-first") {
            expect(r.consolidate.map((n) => n.id).sort()).toEqual(["a", "b"]);
            expect(r.consolidateSum).toBe(70n);
            expect(r.targetWithFee).toBe(100n);
        }
    });

    it("throws when total funds < target", () => {
        const notes = [note("a", 10n), note("b", 20n)];
        expect(() => selectNotes(notes, assetId(1n), circuitAmount(1000n), baseOpts())).toThrow(
            /insufficient/,
        );
    });

    it("bucket shuffle: ±5% bucket randomizes among near-equal notes", () => {
        const notes = [note("a", 100n), note("b", 102n), note("c", 98n)];
        const picks = new Set<string>();
        for (let s = 1; s < 200; s++) {
            const r = selectNotes(notes, assetId(1n), circuitAmount(90n), {
                pick: seededPick(s),
                bucketPct: 0.05,
            });
            if (r.plan === "direct") picks.add(r.notes[0]!.id);
        }
        // All three, not merely "more than one": 98 is the smallest qualifying
        // cover and ±5% of it reaches 100 and 102, so a tiebreak that leaves
        // any of them unreachable is the value-ordering fingerprint returning.
        expect([...picks].sort()).toEqual(["a", "b", "c"]);
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
            const r = selectNotes(notes, assetId(1n), circuitAmount(target), {
                pick: seededPick(trial),
                bucketPct: 0.05,
            });
            if (r.plan !== "direct") continue;
            const ascValues = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
            const picked = BigInt(r.notes[0]!.value);
            const rank = ascValues.indexOf(picked) / Math.max(1, n - 1);
            samples.push(rank);
        }
        const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
        // largest-first ⇒ rank≈1; SFRT should land in lower half.
        expect(mean).toBeLessThan(0.5);
    });
});

describe("maxInputs", () => {
    // The default is the deployed 2×2 arity. A wider circuit lets a spend
    // reach covers that two notes cannot, and lets consolidation merge more
    // per round.
    it("defaults to the default shape's arity, so a third note is reachable", () => {
        // 30+40+50 = 120 covers 115; the best 2-cover is 40+50 = 90, which
        // does not. With no `maxInputs` the default 4×4 arity applies, so this
        // resolves directly instead of consolidating.
        const notes = [note("a", 30n), note("b", 40n), note("c", 50n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(115n), baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes).toHaveLength(3);
        expect(r.sum).toBe(120n);
    });

    it("consolidates instead when the arity is pinned below what a cover needs", () => {
        const notes = [note("a", 30n), note("b", 40n), note("c", 50n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(115n), baseOpts({ maxInputs: 2 }));
        expect(r.plan).toBe("consolidate-first");
    });

    it("finds a three-note cover when the circuit allows three inputs", () => {
        const notes = [note("a", 30n), note("b", 40n), note("c", 50n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(115n), baseOpts({ maxInputs: 3 }));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
        expect(r.sum).toBe(120n);
    });

    it("still prefers the smallest cover, and fewer notes on a tie", () => {
        // A single 100 covers 100; so does 40+60. Equal sums, so the single
        // note wins.
        const notes = [note("single", 100n), note("x", 40n), note("y", 60n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(100n), baseOpts({ maxInputs: 3 }));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes).toHaveLength(1);
        expect(r.notes[0]!.id).toBe("single");
    });

    it("prefers a tighter three-note cover over a looser one-note cover", () => {
        // 10+20+30 = 60 beats the lone 500.
        const notes = [note("big", 500n), note("a", 10n), note("b", 20n), note("c", 30n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(55n), baseOpts({ maxInputs: 3 }));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.sum).toBe(60n);
        expect(r.notes).toHaveLength(3);
    });

    it("consolidates as many notes as the arity allows", () => {
        // Total 100 clears the target, but the best 3-note cover is
        // 20+30+40 = 90, which does not. So the plan is to merge the three
        // smallest rather than just two.
        const notes = [note("a", 10n), note("b", 20n), note("c", 30n), note("d", 40n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(95n), baseOpts({ maxInputs: 3 }));
        expect(r.plan).toBe("consolidate-first");
        if (r.plan !== "consolidate-first") throw new Error("unreachable");
        expect(r.consolidate).toHaveLength(3);
        expect(r.consolidateSum).toBe(60n);
    });
});

describe("notes reserved by an outstanding spend", () => {
    it("are not offered again while the reservation stands", () => {
        const notes = [note("01", 100n, { pendingSpendAt: agoIso(60_000) }), note("02", 100n)];
        const sel = selectNotes(notes, assetId(1n), circuitAmount(50n), baseOpts());
        expect(sel.plan).toBe("direct");
        expect(sel.plan === "direct" && sel.notes.map((n) => n.id)).toEqual(["02"]);
    });

    it("come back once the reservation expires", () => {
        const notes = [note("01", 100n, { pendingSpendAt: agoIso(SPEND_RESERVATION_MS + 1000) })];
        const sel = selectNotes(notes, assetId(1n), circuitAmount(50n), baseOpts());
        expect(sel.plan === "direct" && sel.notes.map((n) => n.id)).toEqual(["01"]);
    });

    it("say so when they are the only thing held", () => {
        const notes = [note("01", 100n, { pendingSpendAt: agoIso(60_000) })];
        expect(() => selectNotes(notes, assetId(1n), circuitAmount(50n), baseOpts())).toThrow(
            /awaiting an earlier spend/,
        );
    });
});

describe("cover search cost", () => {
    // Regression: the branch-and-bound prune only engaged once an incumbent
    // existed, so a wallet whose largest notes cannot reach the target
    // enumerated every C(n, size) before reporting `consolidate-first`. At the
    // default arity of 3 that is ~1.7e8 bigint operations on the main thread —
    // and it is precisely the dusty wallet that needs consolidating.
    it("reports consolidate-first on a large dust wallet without enumerating", () => {
        const notes = Array.from({ length: 1000 }, (_, i) => note((i + 1).toString(16), 1n));

        const started = Date.now();
        const r = selectNotes(notes, assetId(1n), circuitAmount(500n), baseOpts());
        const elapsedMs = Date.now() - started;

        expect(r.plan).toBe("consolidate-first");
        // Generous by three orders of magnitude against the unpruned walk,
        // so this pins the complexity class rather than the machine.
        expect(elapsedMs).toBeLessThan(1000);
    });

    it("still finds the minimal cover when one exists", () => {
        // 1..40: the smallest single note ≥ 30 is 30 itself, and no pair or
        // triple of smaller notes beats it on the fewer-notes tiebreak.
        const notes = Array.from({ length: 40 }, (_, i) =>
            note((i + 1).toString(16), BigInt(i + 1)),
        );

        const r = selectNotes(notes, assetId(1n), circuitAmount(30n), baseOpts());

        expect(r.plan).toBe("direct");
        if (r.plan !== "direct") throw new Error("unreachable");
        expect(r.sum).toBe(30n);
        expect(r.notes).toHaveLength(1);
    });
});
