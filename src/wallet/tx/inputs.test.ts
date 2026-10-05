import { beforeAll, describe, expect, it } from "vitest";
import { buildNoteCommitment } from "../../crypto/commit.js";
import { Poseidon } from "../../crypto/poseidon.js";
import { deriveDiversifiedPk } from "../../keys/diversified.js";
import { defaultDiversifier, diversifierForIndex } from "../../keys/diversifier.js";
import { buildSpendingKey, type SpendingKey } from "../../keys/keys.js";
import type { StoredNote } from "../../protocol/note-record.js";
import type { TreeStore } from "../../sync/tree-store.js";
import { buildInputSlots, type InputsCtx } from "./inputs.js";

describe("buildInputSlots", () => {
    let P: Poseidon;
    let keys: SpendingKey;
    let d0: bigint;
    /** The diversifier of the account's address at `index`. */
    const dAt = (index: number) => diversifierForIndex(keys.ivk, index);

    beforeAll(async () => {
        P = await Poseidon.build();
        keys = buildSpendingKey(P, 43n);
        d0 = defaultDiversifier(keys.ivk);
    });

    const stored = (value: bigint, leafIndex: number, d: bigint = d0): StoredNote => ({
        id: `n${leafIndex}`,
        asset: "1",
        value: value.toString(),
        rho: "111",
        rcm: "222",
        d: d.toString(),
        cm: `0x${leafIndex.toString(16).padStart(64, "0")}`,
        leafIndex,
        spent: false,
        discoveredAt: "2026-01-01T00:00:00.000Z",
    });

    /** A shuffle that leaves the notes in the order given. */
    const inOrder = (n: number) => n - 1;

    const ctx = (nIn = 2): InputsCtx => ({
        P,
        ivk: keys.ivk,
        nsk: keys.nsk,
        nIn,
        treeStore: {
            getPath: () => ({ pathElements: [[0n, 0n, 0n]], pathIndices: [0], root: 0n }),
        } as unknown as TreeStore,
    });

    it("opens the stored note as committed, under the pk of the address it was received at", async () => {
        const [slot] = await buildInputSlots(ctx(), [stored(100n, 0)]);

        // These reproduce the leaf; any other value fails Merkle membership.
        expect(slot?.cached.note).toEqual({
            asset: 1n,
            value: 100n,
            pk: deriveDiversifiedPk(P, keys.ivk, d0),
            rho: 111n,
            rcm: 222n,
        });
        expect(slot?.cached).toMatchObject({ nsk: keys.nsk, d: d0, leafIndex: 0 });
    });

    it("opens each slot under its own note's diversifier", async () => {
        const d5 = dAt(5);
        const slots = await buildInputSlots(
            ctx(3),
            [stored(100n, 0), stored(30n, 1, d5), stored(20n, 2)],
            inOrder,
        );

        expect(slots.map((s) => s?.cached.d)).toEqual([d0, d5, d0]);
        expect(slots.map((s) => s?.cached.note.pk)).toEqual([
            deriveDiversifiedPk(P, keys.ivk, d0),
            deriveDiversifiedPk(P, keys.ivk, d5),
            deriveDiversifiedPk(P, keys.ivk, d0),
        ]);
        expect(slots[1]?.cached.note.pk).not.toBe(slots[0]?.cached.note.pk);
        for (const slot of slots) expect(slot?.cached.nsk).toBe(keys.nsk);
    });

    // The scanner stores the `d` a note's plaintext named and the `rcm` its seed expands to; the
    // slot must open the same commitment the scanner checked.
    it("reproduces the commitment of a note received at a non-default address", async () => {
        const d = dAt(9);
        const cm = buildNoteCommitment(P, {
            asset: 1n,
            value: 30n,
            pk: deriveDiversifiedPk(P, keys.ivk, d),
            rho: 111n,
            rcm: 222n,
        });

        const [slot] = await buildInputSlots(ctx(), [stored(30n, 0, d)]);

        expect(buildNoteCommitment(P, slot!.cached.note)).toBe(cm);
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
        const slots = await buildInputSlots(ctx(), [stored(100n, 0), feeNote], inOrder);

        expect(slots[0]?.cached.note.asset).toBe(1n);
        expect(slots[1]?.cached.note.asset).toBe(2n);
    });

    // The slot order is the order of the spend's public nullifiers, which every output's
    // randomness binds: a spend with no dummy slot differs from an earlier build of itself only
    // through it.
    describe("slot order", () => {
        const notes = () => [stored(100n, 0), stored(30n, 1), stored(20n, 2)];
        const leaves = (slots: Awaited<ReturnType<typeof buildInputSlots>>) =>
            slots.map((s) => s?.cached.leafIndex ?? null);

        it("places the notes as the shuffle draws them, each with its own path", async () => {
            const paths = {
                getPath: (leafIndex: number) => ({
                    pathElements: [[BigInt(leafIndex), 0n, 0n]],
                    pathIndices: [leafIndex],
                    root: 0n,
                }),
            } as unknown as TreeStore;

            // Always picking 0 turns [a, b, c] into [b, c, a].
            const slots = await buildInputSlots({ ...ctx(3), treeStore: paths }, notes(), () => 0);

            expect(leaves(slots)).toEqual([1, 2, 0]);
            expect(slots.map((s) => s?.cached.note.value)).toEqual([30n, 20n, 100n]);
            expect(slots.map((s) => s?.pathIndices)).toEqual([[1], [2], [0]]);
        });

        it("keeps the dummies after the notes", async () => {
            for (let i = 0; i < 20; i++) {
                const slots = await buildInputSlots(ctx(5), notes());

                expect([...leaves(slots).slice(0, 3)].sort()).toEqual([0, 1, 2]);
                expect(slots.slice(3)).toEqual([null, null]);
            }
        });

        it("draws the order anew on every build", async () => {
            const seen = new Set<string>();
            for (let i = 0; i < 80; i++) {
                seen.add(leaves(await buildInputSlots(ctx(3), notes())).join(""));
            }

            // Six orders; 80 uniform draws miss one with probability below 3e-6.
            expect(seen.size).toBe(6);
        });
    });

    it("refuses a path that leads to another root than the spend proves against", async () => {
        await expect(
            buildInputSlots({ ...ctx(), expectedRoot: 1n }, [stored(100n, 0)]),
        ).rejects.toThrow(/different Merkle root/);
    });
});
