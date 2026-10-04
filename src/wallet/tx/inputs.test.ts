import { describe, expect, it } from "vitest";
import type { StoredNote } from "../../protocol/note-record.js";
import type { TreeStore } from "../../sync/tree-store.js";
import { buildInputSlots, type InputsCtx } from "./inputs.js";

const stored = (value: bigint, leafIndex: number): StoredNote => ({
    id: `n${leafIndex}`,
    asset: "1",
    value: value.toString(),
    rho: "111",
    rcm: "222",
    cm: `0x${leafIndex.toString(16).padStart(64, "0")}`,
    leafIndex,
    spent: false,
    discoveredAt: "2026-01-01T00:00:00.000Z",
});

const ctx = (nIn = 2): InputsCtx => ({
    pk: 42n,
    nsk: 43n,
    d: 44n,
    nIn,
    treeStore: {
        getPath: () => ({ pathElements: [[0n, 0n, 0n]], pathIndices: [0], root: 0n }),
    } as unknown as TreeStore,
});

describe("buildInputSlots", () => {
    it("opens the stored note as committed, under the spender's pk", async () => {
        const [slot] = await buildInputSlots(ctx(), [stored(100n, 0)]);

        // These reproduce the leaf; any other value fails Merkle membership.
        expect(slot?.cached.note).toEqual({
            asset: 1n,
            value: 100n,
            pk: 42n,
            rho: 111n,
            rcm: 222n,
        });
    });

    it("opens every slot under the spender's nsk and diversifier", async () => {
        const slots = await buildInputSlots(ctx(), [stored(100n, 0), stored(30n, 1)]);

        for (const slot of slots) expect(slot?.cached).toMatchObject({ nsk: 43n, d: 44n });
    });

    it("pads a single-note spend with a null slot", async () => {
        const slots = await buildInputSlots(ctx(), [stored(100n, 0)]);

        expect(slots[0]).not.toBeNull();
        expect(slots[1]).toBeNull();
    });
    /// A cross-asset fee puts notes of two assets in one spend. Each slot must carry its note's
    /// stored asset; overwriting it would change the commitment whose Merkle membership is proven.
    it("takes each slot's asset from its own note", async () => {
        const feeNote = { ...stored(30n, 1), asset: "2" };
        const slots = await buildInputSlots(ctx(), [stored(100n, 0), feeNote]);

        expect(slots[0]?.cached.note.asset).toBe(1n);
        expect(slots[1]?.cached.note.asset).toBe(2n);
    });
});
