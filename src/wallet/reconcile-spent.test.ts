import { describe, expect, it, vi } from "vitest";
import type { ChainAdapter } from "../chain/port.js";
import { randomFr, randomJubjubScalar } from "../core/random.js";
import { buildNullifierFromNsk } from "../crypto/index.js";
import type { Prover } from "../prover/types.js";
import { SPEND_RESERVATION_MS } from "./constants.js";
import { InMemoryNoteStore, type StoredNote } from "./note-store.js";
import type { NullifierStore } from "./nullifier-store.js";
import { Wallet } from "./wallet.js";

// `reconcileSpentOnChain` runs on every sync over every unspent note, so the
// nullifier derivation behind it is memoised. These pin both halves: the
// derivation happens once per note, and the memo does not grow without bound.

function storedNote(id: string): StoredNote {
    return {
        id,
        asset: "1",
        value: "100",
        rho: randomFr().toString(),
        rcm: randomFr().toString(),
        rcvDep: randomJubjubScalar().toString(),
        cm: `0x${id.padStart(64, "0")}`,
        leafIndex: 0,
        spent: false,
        discoveredAt: "1970-01-01T00:00:00Z",
    };
}

/** Wallet with every network-touching pluggable stubbed out. */
async function makeWallet(notes: StoredNote[], spent: Set<bigint>) {
    const noteStore = new InMemoryNoteStore();
    await noteStore.save({ version: 2, notes });

    const nullifierStore = {
        sync: vi.fn(async () => undefined),
        has: (nf: bigint) => spent.has(nf),
    } as unknown as NullifierStore;

    const wallet = await Wallet.create(
        { type: "nsk", nsk: randomJubjubScalar() },
        {
            chainId: 31337n,
            treeDepth: 10,
            relayerAddress: `0x${"11".repeat(20)}`,
            chain: {} as ChainAdapter,
            // Never dialled: every consumer of the client is stubbed.
            fmdUrl: "http://fmd.invalid",
            noteStore,
            // An empty page: these tests drive `reconcileSpentOnChain`, which
            // reads the local store, so the feed only has to terminate paging.
            noteSource: { listNotes: async () => ({ inputs: [], nextAfter: 0, resumeAfter: 0 }) },
            nullifierStore,
            submitter: { submit: async () => ({}) } as never,
            prover: {} as Prover,
        },
    );
    return { wallet, nullifierStore };
}

/** `buildNullifierFromNsk` bottoms out in `P.hash`, so this counts derivations. */
function countDerivations(wallet: Wallet) {
    return vi.spyOn(wallet.P, "hash");
}

describe("reconcileSpentOnChain", () => {
    it("derives each note's nullifier once across repeated passes", async () => {
        const { wallet } = await makeWallet([storedNote("a"), storedNote("b")], new Set());

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
        const { wallet } = await makeWallet(notes, spent);

        await wallet.reconcileSpentOnChain();
        expect(wallet.file.notes.filter((n) => n.spent)).toHaveLength(0);

        // Spend note "a" on chain, then re-run: the memo must not stop the
        // newly-present nullifier from being noticed.
        const a = wallet.file.notes.find((n) => n.id === "a");
        if (!a) throw new Error("fixture note missing");
        spent.add(buildNullifierFromNsk(wallet.P, wallet.keys.nsk, BigInt(a.rho), BigInt(a.cm)));

        await wallet.reconcileSpentOnChain();
        expect(wallet.file.notes.filter((n) => n.spent).map((n) => n.id)).toEqual(["a"]);
    });

    it("drops memo entries for notes that are no longer candidates", async () => {
        const notes = [storedNote("a"), storedNote("b")];
        const { wallet } = await makeWallet(notes, new Set());
        await wallet.reconcileSpentOnChain();

        // `markSpent` retires "a" outside the reconcile path; the next pass
        // must evict it rather than hold its nullifier forever.
        await wallet.markSpent(["a"]);
        await wallet.reconcileSpentOnChain();

        const memo = (wallet as unknown as { nullifierCache: Map<string, bigint> }).nullifierCache;
        expect([...memo.keys()]).toEqual(["b"]);
    });
});

describe("spend reservations", () => {
    const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

    it("releases a reservation whose spend never landed", async () => {
        const { wallet } = await makeWallet([storedNote("a")], new Set());
        await wallet.markPendingSpend(["a"]);
        expect(wallet.file.notes[0]?.pendingSpendAt).toBeDefined();

        // Still within the window: the answer is not in yet, so the note stays
        // reserved rather than being handed back to the selector.
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
        const { wallet } = await makeWallet([storedNote("a")], spent);
        await wallet.markPendingSpend(["a"]);

        const a = wallet.file.notes.find((n) => n.id === "a");
        if (!a) throw new Error("fixture note missing");
        spent.add(buildNullifierFromNsk(wallet.P, wallet.keys.nsk, BigInt(a.rho), BigInt(a.cm)));

        await wallet.reconcileSpentOnChain();
        expect(wallet.file.notes[0]?.spent).toBe(true);
        expect(wallet.file.notes[0]?.pendingSpendAt).toBeUndefined();
    });
});
