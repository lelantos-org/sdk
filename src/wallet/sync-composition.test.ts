import { describe, expect, it } from "vitest";
import { buildNullifierFromNsk } from "../crypto/index.js";
import { incomingHit, scannerYielding, storedNote, testWallet } from "./wallet-test-utils.js";

// `syncWallet` and `reconcileSpentOnChain` are each covered in isolation.
// The bugs these pin live only in their composition: the sync persisted new
// notes through one `NotesFile` while reconciliation held a second, older one,
// and whichever saved last erased the other's writes.

describe("syncNotes composed with reconciliation", () => {
    it("keeps a newly-scanned note when the same sync also marks one spent", async () => {
        const existing = storedNote("a");
        const spent = new Set<bigint>();
        const { wallet, noteStore } = await testWallet({
            notes: [existing],
            spent,
            scanner: scannerYielding([incomingHit()]),
        });

        // "a" is spent on chain, so reconciliation has a real mutation to
        // persist — which is what made it overwrite the sync's writes.
        spent.add(
            buildNullifierFromNsk(
                wallet.P,
                wallet.keys.nsk,
                BigInt(existing.rho),
                BigInt(existing.cm),
            ),
        );

        await wallet.syncNotes();

        const ids = wallet.file.notes.map((n) => n.cm);
        expect(ids).toHaveLength(2);
        expect(wallet.file.notes.find((n) => n.id === "a")?.spent).toBe(true);

        // The store must agree with the in-memory view, not lag behind it.
        const persisted = await noteStore.load();
        expect(persisted.notes).toHaveLength(2);
        expect(persisted.notes.find((n) => n.id === "a")?.spent).toBe(true);
    });

    it("does not rewind the persisted cursor when reconciliation writes", async () => {
        const existing = storedNote("a");
        const spent = new Set<bigint>();
        const { wallet, noteStore } = await testWallet({
            notes: [existing],
            spent,
            scanner: scannerYielding([incomingHit()]),
        });
        spent.add(
            buildNullifierFromNsk(
                wallet.P,
                wallet.keys.nsk,
                BigInt(existing.rho),
                BigInt(existing.cm),
            ),
        );

        const result = await wallet.syncNotes();

        expect(result.cursor).toBe(1);
        expect((await noteStore.load()).cursor).toBe(1);
    });
});

describe("concurrent syncs", () => {
    it("serialises overlapping syncs instead of repeating their work", async () => {
        // Both would otherwise read the same starting cursor, page the same
        // range, and race to persist — so the later `checkpoint` can rewind
        // the cursor the earlier one advanced, costing a full re-scan next
        // time and making `SyncResult.cursor` a lie.
        const { wallet, source } = await testWallet({
            scanner: scannerYielding([]),
            feedRows: 2000,
        });

        const [a, b] = await Promise.all([
            wallet.syncNotes({ limit: 500 }),
            wallet.syncNotes({ limit: 500 }),
        ]);

        // The second sync starts where the first finished, so it fetches only
        // the empty confirmation page.
        expect(Math.max(a.pages, b.pages)).toBe(5);
        expect(Math.min(a.pages, b.pages)).toBe(1);
        expect(source.listNotes).toHaveBeenCalledTimes(6);
        // The cursor only ever moves forward.
        expect(a.cursor).toBe(2000);
        expect(b.cursor).toBe(2000);
    });

    it("does not let a failed sync block the next one", async () => {
        const { wallet } = await testWallet({
            scanner: {
                scan: async () => {
                    throw new Error("scanner died");
                },
            },
        });

        await expect(wallet.syncNotes()).rejects.toThrow("scanner died");
        // The queue must settle rather than stay poisoned.
        await expect(wallet.syncNotes()).rejects.toThrow("scanner died");
    });
});
