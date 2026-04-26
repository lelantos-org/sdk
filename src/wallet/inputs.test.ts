import { describe, expect, it } from "vitest";
import type { StoredNote } from "../core/note-record.js";
import { buildInputSlots, type InputsCtx } from "./inputs.js";
import type { TreeStore } from "./tree-store.js";

// The spend-time blinder must be fresh per transaction: `in_cv = value·gen +
// rcv·H` is a public input, so a constant `rcv` publishes an unblinded
// commitment to the amount and makes two spends of equal value identical.

const stored = (value: bigint, leafIndex: number): StoredNote => ({
    id: `n${leafIndex}`,
    asset: "1",
    value: value.toString(),
    rho: "111",
    rcm: "222",
    rcvDep: "333",
    cm: `0x${leafIndex.toString(16).padStart(64, "0")}`,
    leafIndex,
    spent: false,
    discoveredAt: "2026-01-01T00:00:00.000Z",
});

const ctx = (): InputsCtx => ({
    pk: 42n,
    nsk: 43n,
    treeStore: {
        getPath: () => ({ pathElements: [[0n, 0n, 0n]], pathIndices: [0], root: 0n }),
    } as unknown as TreeStore,
});

describe("buildInputSlots", () => {
    it("draws a fresh value-commitment blinder per spend", async () => {
        const [first] = await buildInputSlots(ctx(), [stored(100n, 0)], 1n);
        const [second] = await buildInputSlots(ctx(), [stored(100n, 0)], 1n);

        expect(first?.cached.note.rcv).not.toBe(0n);
        expect(second?.cached.note.rcv).not.toBe(0n);
        expect(first?.cached.note.rcv).not.toBe(second?.cached.note.rcv);
    });

    it("keeps rcvDep pinned to the stored note", async () => {
        const [slot] = await buildInputSlots(ctx(), [stored(100n, 0)], 1n);

        // rcv_dep reproduces the committed leaf; re-randomising it would make
        // the Merkle membership check fail.
        expect(slot?.cached.note.rcvDep).toBe(333n);
        expect(slot?.cached.note.rho).toBe(111n);
    });

    it("pads a single-note spend with a null slot", async () => {
        const slots = await buildInputSlots(ctx(), [stored(100n, 0)], 1n);

        expect(slots[0]).not.toBeNull();
        expect(slots[1]).toBeNull();
    });
});
