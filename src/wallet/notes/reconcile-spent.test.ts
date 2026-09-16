import { describe, expect, it, vi } from "vitest";
import { buildNullifierFromNsk } from "../../crypto/index.js";
import { storedNote, testWallet } from "../../test-utils/wallet.js";
import { SPEND_RESERVATION_MS } from "../constants.js";
import type { WalletInternals } from "../surface/internals.js";

// `reconcileSpentOnChain` runs on every sync over every unspent note, so nullifier derivation is
// memoised. These tests check that derivation happens once per note and the memo stays bounded.

/** `buildNullifierFromNsk` bottoms out in `P.hash`, so this counts derivations. */
function countDerivations(wallet: WalletInternals) {
    return vi.spyOn(wallet.P, "hash");
}

describe("reconcileSpentOnChain", () => {
    it("derives each note's nullifier once across repeated passes", async () => {
        const { internals: wallet } = await testWallet({
            notes: [storedNote("a"), storedNote("b")],
        });

        const hash = countDerivations(wallet);
        await wallet.reconcileSpentOnChain();
        const afterFirst = hash.mock.calls.length;

        await wallet.reconcileSpentOnChain();
        await wallet.reconcileSpentOnChain();

        expect(afterFirst).toBeGreaterThan(0);
        expect(hash.mock.calls.length).toBe(afterFirst);
    });

    it("marks a note spent once its nullifier shows up in the mirror", async () => {
        const notes = [storedNote("a"), storedNote("b")];
        const spent = new Set<bigint>();
        const { internals: wallet } = await testWallet({ notes, spent });

        await wallet.reconcileSpentOnChain();
        expect(wallet.file.notes.filter((n) => n.spent)).toHaveLength(0);

        // Spend note "a" on-chain; the memo must not hide the newly present nullifier.
        const a = wallet.file.notes.find((n) => n.id === "a");
        if (!a) throw new Error("fixture note missing");
        spent.add(buildNullifierFromNsk(wallet.P, wallet.keys.nsk, BigInt(a.rho), BigInt(a.cm)));

        await wallet.reconcileSpentOnChain();
        expect(wallet.file.notes.filter((n) => n.spent).map((n) => n.id)).toEqual(["a"]);
    });

    it("drops memo entries for notes that are no longer candidates", async () => {
        const notes = [storedNote("a"), storedNote("b")];
        const { internals: wallet } = await testWallet({ notes });
        await wallet.reconcileSpentOnChain();

        // `markSpent` retires "a" outside the reconcile path; the next pass must evict it.
        await wallet.markSpent(["a"]);
        await wallet.reconcileSpentOnChain();

        expect(wallet.nullifiers.has("a")).toBe(false);
        expect(wallet.nullifiers.has("b")).toBe(true);
        expect(wallet.nullifiers.size).toBe(1);
    });
});

describe("spend reservations", () => {
    const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

    it("releases a reservation whose spend never landed", async () => {
        const { internals: wallet } = await testWallet({ notes: [storedNote("a")] });
        await wallet.markPendingSpend(["a"]);
        expect(wallet.file.notes[0]?.pendingSpendAt).toBeDefined();

        // Within the reservation window the note stays reserved.
        await wallet.reconcileSpentOnChain();
        expect(wallet.file.notes[0]?.pendingSpendAt).toBeDefined();

        const stale = wallet.file.notes[0];
        if (!stale) throw new Error("fixture note missing");
        stale.pendingSpendAt = agoIso(SPEND_RESERVATION_MS + 1000);
        await wallet.reconcileSpentOnChain();
        expect(wallet.file.notes[0]?.pendingSpendAt).toBeUndefined();
        expect(wallet.file.notes[0]?.spent).toBe(false);
    });

    it("retires a reservation the nullifier feed has answered", async () => {
        const spent = new Set<bigint>();
        const { internals: wallet } = await testWallet({ notes: [storedNote("a")], spent });
        await wallet.markPendingSpend(["a"]);

        const a = wallet.file.notes.find((n) => n.id === "a");
        if (!a) throw new Error("fixture note missing");
        spent.add(buildNullifierFromNsk(wallet.P, wallet.keys.nsk, BigInt(a.rho), BigInt(a.cm)));

        await wallet.reconcileSpentOnChain();
        expect(wallet.file.notes[0]?.spent).toBe(true);
        expect(wallet.file.notes[0]?.pendingSpendAt).toBeUndefined();
    });
});
