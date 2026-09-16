import { describe, expect, it } from "vitest";
import { buildNullifierFromNsk } from "../../crypto/index.js";
import { incomingHit, scannerYielding, storedNote, testWallet } from "../../test-utils/wallet.js";

// Tests for `syncWallet` composed with `reconcileSpentOnChain`: both must write through the same
// `NotesFile`, so neither save overwrites the other's changes.

describe("a notes sync composed with reconciliation", () => {
    it("keeps a newly-scanned note when the same sync also marks one spent", async () => {
        const existing = storedNote("a");
        const spent = new Set<bigint>();
        const { wallet, internals, noteStore } = await testWallet({
            notes: [existing],
            spent,
            scanner: scannerYielding([incomingHit()]),
        });

        // "a" is spent on-chain, so reconciliation persists a mutation in the same sync.
        spent.add(
            buildNullifierFromNsk(
                internals.P,
                internals.keys.nsk,
                BigInt(existing.rho),
                BigInt(existing.cm),
            ),
        );

        await wallet.sync({ scope: "notes" });

        const ids = internals.file.notes.map((n) => n.cm);
        expect(ids).toHaveLength(2);
        expect(internals.file.notes.find((n) => n.id === "a")?.spent).toBe(true);

        // The store must match the in-memory view.
        const persisted = await noteStore.load();
        expect(persisted.notes).toHaveLength(2);
        expect(persisted.notes.find((n) => n.id === "a")?.spent).toBe(true);
    });

    it("does not rewind the persisted cursor when reconciliation writes", async () => {
        const existing = storedNote("a");
        const spent = new Set<bigint>();
        const { wallet, internals, noteStore } = await testWallet({
            notes: [existing],
            spent,
            scanner: scannerYielding([incomingHit()]),
        });
        spent.add(
            buildNullifierFromNsk(
                internals.P,
                internals.keys.nsk,
                BigInt(existing.rho),
                BigInt(existing.cm),
            ),
        );

        const report = await wallet.sync({ scope: "notes" });

        expect(report.notes.cursor).toBe(1);
        expect((await noteStore.load()).cursor).toBe(1);
    });
});

describe("concurrent syncs", () => {
    it("serialises overlapping syncs instead of repeating their work", async () => {
        // Unserialised syncs would read the same starting cursor, page the same range and race to
        // persist, so a later `checkpoint` could rewind the cursor and make `SyncResult.cursor`
        // inaccurate.
        const { wallet, source } = await testWallet({
            scanner: scannerYielding([]),
            feedRows: 2000,
        });

        const [a, b] = await Promise.all([
            wallet.sync({ scope: "notes", pageSize: 500 }),
            wallet.sync({ scope: "notes", pageSize: 500 }),
        ]);

        // The second sync starts where the first finished and fetches only the empty final page.
        expect(Math.max(a.notes.pages, b.notes.pages)).toBe(5);
        expect(Math.min(a.notes.pages, b.notes.pages)).toBe(1);
        expect(source.listNotes).toHaveBeenCalledTimes(6);
        // The cursor only moves forward.
        expect(a.notes.cursor).toBe(2000);
        expect(b.notes.cursor).toBe(2000);
    });

    it("does not let a failed sync block the next one", async () => {
        const { wallet } = await testWallet({
            scanner: {
                scan: async () => {
                    throw new Error("scanner died");
                },
            },
        });

        await expect(wallet.sync({ scope: "notes" })).rejects.toThrow("scanner died");
        // A failed sync must not block the queue.
        await expect(wallet.sync({ scope: "notes" })).rejects.toThrow("scanner died");
    });
});
