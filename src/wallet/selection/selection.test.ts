import { describe, expect, it } from "vitest";
import { assetId, circuitAmount } from "../../core/brand.js";
import { randomBelow } from "../../core/random.js";
import { NotesHeldError } from "../../errors/funds.js";
import { storedNote } from "../../test-utils/wallet.js";
import { SPEND_RESERVATION_MS } from "../constants.js";
import { type SelectOpts, selectNotes, spendableMax } from "./index.js";

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
 * A seeded `SelectOpts.pick` that drives the real {@link randomBelow} from a
 * seeded byte stream, so tests exercise the production index derivation.
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
            expect.objectContaining({
                code: "INSUFFICIENT_BALANCE",
                available: 0n,
                required: 100n,
                retryable: false,
            }),
        );
    });

    it("filters spent notes", () => {
        const notes = [storedNote("a", 100n, { spent: true }), storedNote("b", 200n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(50n), baseOpts());
        expect(r.plan).toBe("direct");
        if (r.plan === "direct") expect(r.notes.map((n) => n.id)).toEqual(["b"]);
    });

    it("filters by asset", () => {
        const notes = [storedNote("a", 1000n, { asset: 2n }), storedNote("b", 100n, { asset: 1n })];
        const r = selectNotes(notes, assetId(1n), circuitAmount(50n), baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes[0]!.id).toBe("b");
    });

    it("single-cover prefers smallest sufficient note (not largest)", () => {
        const notes = [
            storedNote("a", 50n),
            storedNote("b", 200n),
            storedNote("c", 1000n),
            storedNote("d", 5000n),
        ];
        const r = selectNotes(notes, assetId(1n), circuitAmount(100n), baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes).toHaveLength(1);
        expect(r.notes[0]!.id).toBe("b");
        expect(r.sum).toBe(200n);
    });

    it("respects fee in cover threshold", () => {
        const notes = [storedNote("a", 100n), storedNote("b", 110n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(100n), baseOpts({ fee: 5n }));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes[0]!.id).toBe("b");
    });

    it("two-cover picks smallest pair, not largest+gap", () => {
        const notes = [
            storedNote("a", 30n),
            storedNote("b", 40n),
            storedNote("c", 60n),
            storedNote("d", 1000n),
        ];
        // target 80 → smallest pair (a=30, c=60)=90; large `d` kept for later.
        const r = selectNotes(notes, assetId(1n), circuitAmount(80n), baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        const ids = r.notes.map((n) => n.id).sort();
        expect(ids).toEqual(["a", "c"]);
        expect(r.sum).toBe(90n);
    });

    it("excludes dust below threshold", () => {
        const notes = [storedNote("dust", 1n), storedNote("ok", 200n)];
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
        const notes = [storedNote("a", 50n), storedNote("b", 50n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(100n), baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes).toHaveLength(2);
    });

    it("skips notes still in cooldown window", () => {
        const notes = [
            storedNote("fresh", 1000n, { firstSeenBlock: 99 }),
            storedNote("ripe", 200n, { firstSeenBlock: 50 }),
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
        const notes = [storedNote("a", 200n, { firstSeenBlock: 100 })];

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

    it("counts only this asset's unspent notes toward the balance", () => {
        // Spent notes and other assets are not held back: they do not exist for this spend.
        const notes = [
            storedNote("spent", 500n, { spent: true }),
            storedNote("other", 500n, { asset: 2n }),
            storedNote("dusty", 1n),
        ];
        expect(() =>
            selectNotes(notes, assetId(1n), circuitAmount(100n), { dustThreshold: 10n }),
        ).toThrow(expect.objectContaining({ code: "INSUFFICIENT_BALANCE", available: 1n }));
    });

    it("reports held-back notes by rule when they would cover the amount", () => {
        // Distinguishes a wallet waiting on an earlier spend or a block from an empty one.
        const reservedAt = new Date().toISOString();
        const notes = [
            storedNote("reserved", 60n, { pendingSpendAt: reservedAt }),
            storedNote("young", 50n, { firstSeenBlock: 100 }),
            storedNote("dusty", 5n),
        ];
        let err: unknown;
        try {
            selectNotes(notes, assetId(1n), circuitAmount(100n), {
                dustThreshold: 10n,
                tipBlock: 100,
                cooldownBlocks: 1,
            });
        } catch (e) {
            err = e;
        }
        expect(err).toBeInstanceOf(NotesHeldError);
        const held = err as NotesHeldError;
        expect(held).toMatchObject({
            code: "NOTES_HELD",
            spendable: 0n,
            required: 100n,
            retryable: true,
            held: {
                reserved: { value: 60n, count: 1 },
                cooldown: { value: 50n, count: 1 },
                dust: { value: 5n, count: 1 },
            },
        });
        expect(held.reservedUntil?.getTime()).toBeGreaterThan(Date.now());
        // Counts, never amounts or ids, in the message; the long-standing wording is kept.
        expect(held.message).toMatch(/1 awaiting an earlier spend, 1 in spend cooldown/);
        expect(held.message).not.toMatch(/60|reserved"/);
    });

    it("is not retryable when only dust would close the gap", () => {
        const notes = [storedNote("a", 90n), storedNote("dusty", 5n), storedNote("dusty2", 6n)];
        expect(() =>
            selectNotes(notes, assetId(1n), circuitAmount(100n), { dustThreshold: 10n }),
        ).toThrow(expect.objectContaining({ code: "NOTES_HELD", retryable: false }));
    });

    it("ignores cooldown when firstSeenBlock missing", () => {
        const notes = [storedNote("a", 200n)];
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
        const notes = [storedNote("a", 30n), storedNote("b", 40n), storedNote("c", 50n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(100n), baseOpts({ maxInputs: 2 }));
        expect(r.plan).toBe("consolidate-first");
        if (r.plan === "consolidate-first") {
            expect(r.consolidate.map((n) => n.id).sort()).toEqual(["a", "b"]);
            expect(r.consolidateSum).toBe(70n);
            expect(r.targetWithFee).toBe(100n);
        }
    });

    it("throws when total funds < target", () => {
        const notes = [storedNote("a", 10n), storedNote("b", 20n)];
        expect(() => selectNotes(notes, assetId(1n), circuitAmount(1000n), baseOpts())).toThrow(
            /insufficient/,
        );
    });

    it("bucket shuffle: ±5% bucket randomizes among near-equal notes", () => {
        const notes = [storedNote("a", 100n), storedNote("b", 102n), storedNote("c", 98n)];
        const picks = new Set<string>();
        for (let s = 1; s < 200; s++) {
            const r = selectNotes(notes, assetId(1n), circuitAmount(90n), {
                pick: seededPick(s),
                bucketPct: 0.05,
            });
            if (r.plan === "direct") picks.add(r.notes[0]!.id);
        }
        // All three: 98 is the smallest qualifying cover and ±5% of it reaches
        // 100 and 102, so leaving any unreachable is a value-ordering
        // fingerprint.
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
            const notes = values.map((v, i) => storedNote(i.toString(16), v));
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
    // A wider circuit lets a spend reach covers that fewer notes cannot, and
    // lets consolidation merge more per round.
    it("defaults to the default shape's arity, so a third note is reachable", () => {
        // 30+40+50 = 120 covers 115; the best 2-cover, 40+50 = 90, does not.
        // Without `maxInputs` the default 4×4 arity applies, so this resolves
        // directly.
        const notes = [storedNote("a", 30n), storedNote("b", 40n), storedNote("c", 50n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(115n), baseOpts());
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes).toHaveLength(3);
        expect(r.sum).toBe(120n);
    });

    it("consolidates instead when the arity is pinned below what a cover needs", () => {
        const notes = [storedNote("a", 30n), storedNote("b", 40n), storedNote("c", 50n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(115n), baseOpts({ maxInputs: 2 }));
        expect(r.plan).toBe("consolidate-first");
    });

    it("finds a three-note cover when the circuit allows three inputs", () => {
        const notes = [storedNote("a", 30n), storedNote("b", 40n), storedNote("c", 50n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(115n), baseOpts({ maxInputs: 3 }));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
        expect(r.sum).toBe(120n);
    });

    it("still prefers the smallest cover, and fewer notes on a tie", () => {
        // A single 100 covers 100; so does 40+60. Equal sums, so the single
        // note wins.
        const notes = [storedNote("single", 100n), storedNote("x", 40n), storedNote("y", 60n)];
        const r = selectNotes(notes, assetId(1n), circuitAmount(100n), baseOpts({ maxInputs: 3 }));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.notes).toHaveLength(1);
        expect(r.notes[0]!.id).toBe("single");
    });

    it("prefers a tighter three-note cover over a looser one-note cover", () => {
        // 10+20+30 = 60 beats the lone 500.
        const notes = [
            storedNote("big", 500n),
            storedNote("a", 10n),
            storedNote("b", 20n),
            storedNote("c", 30n),
        ];
        const r = selectNotes(notes, assetId(1n), circuitAmount(55n), baseOpts({ maxInputs: 3 }));
        if (r.plan !== "direct") throw new Error("expected direct");
        expect(r.sum).toBe(60n);
        expect(r.notes).toHaveLength(3);
    });

    it("consolidates as many notes as the arity allows", () => {
        // Total 100 clears the target, but the best 3-note cover is
        // 20+30+40 = 90, which does not, so the three smallest are merged.
        const notes = [
            storedNote("a", 10n),
            storedNote("b", 20n),
            storedNote("c", 30n),
            storedNote("d", 40n),
        ];
        const r = selectNotes(notes, assetId(1n), circuitAmount(95n), baseOpts({ maxInputs: 3 }));
        expect(r.plan).toBe("consolidate-first");
        if (r.plan !== "consolidate-first") throw new Error("unreachable");
        expect(r.consolidate).toHaveLength(3);
        expect(r.consolidateSum).toBe(60n);
    });
});

describe("notes reserved by an outstanding spend", () => {
    it("are not offered again while the reservation stands", () => {
        const notes = [
            storedNote("01", 100n, { pendingSpendAt: agoIso(60_000) }),
            storedNote("02", 100n),
        ];
        const sel = selectNotes(notes, assetId(1n), circuitAmount(50n), baseOpts());
        expect(sel.plan).toBe("direct");
        expect(sel.plan === "direct" && sel.notes.map((n) => n.id)).toEqual(["02"]);
    });

    it("come back once the reservation expires", () => {
        const notes = [
            storedNote("01", 100n, { pendingSpendAt: agoIso(SPEND_RESERVATION_MS + 1000) }),
        ];
        const sel = selectNotes(notes, assetId(1n), circuitAmount(50n), baseOpts());
        expect(sel.plan === "direct" && sel.notes.map((n) => n.id)).toEqual(["01"]);
    });

    it("say so when they are the only thing held", () => {
        const notes = [storedNote("01", 100n, { pendingSpendAt: agoIso(60_000) })];
        expect(() => selectNotes(notes, assetId(1n), circuitAmount(50n), baseOpts())).toThrow(
            /awaiting an earlier spend/,
        );
    });
});

describe("cover search cost", () => {
    // Without a seeded incumbent, the branch-and-bound prune would not engage
    // for a wallet whose largest notes cannot reach the target, enumerating
    // every C(n, size) (~1.7e8 bigint operations at size 3) before reporting
    // `consolidate-first`.
    it("reports consolidate-first on a large dust wallet without enumerating", () => {
        const notes = Array.from({ length: 1000 }, (_, i) => storedNote((i + 1).toString(16), 1n));

        const started = Date.now();
        const r = selectNotes(notes, assetId(1n), circuitAmount(500n), baseOpts());
        const elapsedMs = Date.now() - started;

        expect(r.plan).toBe("consolidate-first");
        // Three orders of magnitude below the unpruned walk, so this checks the
        // complexity class rather than machine speed.
        expect(elapsedMs).toBeLessThan(1000);
    });

    it("still finds the minimal cover when one exists", () => {
        // 1..40: the smallest single note ≥ 30 is 30 itself, and no pair or
        // triple of smaller notes beats it on the fewer-notes tiebreak.
        const notes = Array.from({ length: 40 }, (_, i) =>
            storedNote((i + 1).toString(16), BigInt(i + 1)),
        );

        const r = selectNotes(notes, assetId(1n), circuitAmount(30n), baseOpts());

        expect(r.plan).toBe("direct");
        if (r.plan !== "direct") throw new Error("unreachable");
        expect(r.sum).toBe(30n);
        expect(r.notes).toHaveLength(1);
    });
});

// `only` lets consolidation force a merge. Selecting by amount alone lets SFRT
// pick a single larger note and merge none of the dust.
describe("selectNotes with `only`", () => {
    // The dust to merge sums to 30; note `03` alone covers the target for 28.
    // Smallest-sum wins, so unrestricted selection takes `03`.
    const notes = [storedNote("01", 10n), storedNote("02", 20n), storedNote("03", 28n)];
    const target = circuitAmount(27n);

    it("covers from the named notes even when a cheaper cover exists", () => {
        const r = selectNotes(notes, assetId(1n), target, { only: ["01", "02"], maxInputs: 4 });
        expect(r.plan).toBe("direct");
        if (r.plan !== "direct") return;
        expect(r.notes.map((n) => n.id).sort()).toEqual(["01", "02"]);
    });

    it("takes the cheaper single note when nothing restricts it", () => {
        // The behaviour `only` overrides, asserted so the previous test stays
        // meaningful.
        const r = selectNotes(notes, assetId(1n), target, { maxInputs: 4 });
        expect(r.plan).toBe("direct");
        if (r.plan !== "direct") return;
        expect(r.notes.map((n) => n.id)).toEqual(["03"]);
    });

    it("does not resurrect a note the other rules exclude", () => {
        // `only` narrows the candidate set and never widens it. With `01` spent,
        // the named pair cannot reach the target.
        const withSpent = [
            storedNote("01", 10n, { spent: true }),
            storedNote("02", 20n),
            storedNote("03", 28n),
        ];
        expect(() =>
            selectNotes(withSpent, assetId(1n), target, { only: ["01", "02"], maxInputs: 4 }),
        ).toThrow(expect.objectContaining({ code: "INSUFFICIENT_BALANCE" }));
    });
});

// The value a "max" button should use. A max derived from the balance can be
// refused by the selector.
describe("spendableMax", () => {
    it("sums the largest notes the slots hold, and blames the cap for the rest", () => {
        const notes = [
            storedNote("01", 1n),
            storedNote("02", 50n),
            storedNote("03", 2n),
            storedNote("04", 40n),
        ];
        expect(spendableMax(notes, assetId(1n), { maxInputs: 4 }).max).toBe(93n);

        const capped = spendableMax(notes, assetId(1n), { maxInputs: 2 });
        expect(capped.max).toBe(90n);
        // Reachable by consolidating, unlike the time-based causes.
        expect(capped.withheld.slots).toBe(3n);
        expect(capped.withheld.cooldown).toBe(0n);
        expect(capped.withheld.reserved).toBe(0n);
    });

    it("attributes a reserved note to the reservation, not the slot cap", () => {
        const notes = [
            storedNote("01", 100n),
            storedNote("02", 7n, { pendingSpendAt: agoIso(60_000) }),
        ];
        const r = spendableMax(notes, assetId(1n), { maxInputs: 4 });
        expect(r.max).toBe(100n);
        expect(r.withheld.reserved).toBe(7n);
        expect(r.withheld.slots).toBe(0n);
    });

    it("attributes a cooling-down note to the cooldown", () => {
        const notes = [storedNote("01", 100n), storedNote("02", 7n, { firstSeenBlock: 30 })];
        const r = spendableMax(notes, assetId(1n), { maxInputs: 4, tipBlock: 30 });
        expect(r.max).toBe(100n);
        expect(r.withheld.cooldown).toBe(7n);
    });

    it("subtracts a same-asset fee, and never reports a negative", () => {
        expect(spendableMax([storedNote("01", 100n)], assetId(1n), { fee: 7n }).max).toBe(93n);
        expect(spendableMax([storedNote("01", 5n)], assetId(1n), { fee: 10n }).max).toBe(0n);
        expect(spendableMax([], assetId(1n), {}).max).toBe(0n);
    });

    it("is a target the selector actually accepts", () => {
        // The returned max must never be rejected as insufficient cover.
        const notes = [
            storedNote("01", 1n),
            storedNote("02", 50n),
            storedNote("03", 2n),
            storedNote("04", 40n),
        ];
        for (const maxInputs of [1, 2, 3, 4]) {
            const { max } = spendableMax(notes, assetId(1n), { maxInputs });
            const r = selectNotes(notes, assetId(1n), circuitAmount(max), { maxInputs });
            expect(r.plan).toBe("direct");
        }
    });
});
