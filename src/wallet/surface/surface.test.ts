// The read surface: one `sync` with a report per stream, `balance` whose split
// adds up, an immutable coalesced `state()`, operations tracked with their `opId`, and
// `walletInternals` as the only way to the plumbing.

import { describe, expect, it, vi } from "vitest";
import type { ChainAdapter } from "../../chain/port.js";
import { assetId, circuitAmount, evmAddress } from "../../core/brand.js";
import { isWalletError } from "../../errors/guard.js";
import type { TreeStore } from "../../sync/tree-store.js";
import { scannerYielding, storedNote, testWallet } from "../../test-utils/wallet.js";
import type { SyncProgress, WalletState } from "../types/sync.js";
import { walletInternals } from "./internals.js";
import { WalletStateStore } from "./state.js";

/** Knows asset 1 (plain, scale 1), at chain tip 100. */
const chain = {
    chainId: async () => 31337n,
    blockNumber: async () => 100,
    maspAddress: async () => evmAddress(`0x${"cc".repeat(20)}`),
    fetchAsset: async () => ({
        token: evmAddress(`0x${"aa".repeat(20)}`),
        scale: 1n,
        disabled: false,
        depositBps: 0n,
        withdrawBps: 0n,
    }),
    tokenMeta: async () => ({ symbol: "T1", decimals: 6 }),
    nativeAdapterAddress: () => undefined,
} as unknown as ChainAdapter;

const microtask = () => new Promise<void>((r) => queueMicrotask(r));

describe("sync", () => {
    const treeSummary = { chunksFetched: 1, leavesAdded: 4, syncedCount: 4, stoppedBy: "complete" };

    async function withTree() {
        const treeStore = {
            sync: vi.fn(async (opts: { onProgress?: (p: unknown) => void } = {}) => {
                opts.onProgress?.({ chunkId: 0, leaves: 4, syncedCount: 4 });
                return treeSummary;
            }),
        } as unknown as TreeStore;
        const nullifierStore = {
            sync: vi.fn(async () => ({
                chunksFetched: 1,
                added: 0,
                syncedCount: 0,
                stoppedBy: "complete",
            })),
            has: () => false,
        };
        const t = await testWallet({
            chain,
            nullifierStore: nullifierStore as never,
            scanner: scannerYielding([]),
        });
        (walletInternals(t.wallet).cfg as { treeStore: TreeStore }).treeStore = treeStore;
        return { ...t, treeStore, nullifierStore };
    }

    it("reports each stream it ran: the tree only for scope full", async () => {
        const { wallet, treeStore } = await withTree();
        const full = await wallet.sync();
        expect(full.tree).toEqual(treeSummary);
        expect(full.nullifiers).toMatchObject({ chunksFetched: 1 });
        expect(full.syncedAt).toBeInstanceOf(Date);

        const notes = await wallet.sync({ scope: "notes" });
        expect(notes.tree).toBeUndefined();
        expect(treeStore.sync).toHaveBeenCalledOnce();
        expect(wallet.state().sync).toMatchObject({ status: "idle", lastReport: notes });
    });

    it("tags progress by stream and swallows a throwing listener", async () => {
        const { wallet } = await withTree();
        const streams = new Set<string>();
        const report = await wallet.sync({
            onProgress: (p: SyncProgress) => {
                streams.add(p.stream);
                throw new Error("listener bug");
            },
        });
        expect(report.notes.stoppedBy).toBe("exhausted");
        expect(streams).toEqual(new Set(["notes", "tree"]));
    });

    it("reloads the note store first when asked", async () => {
        const { wallet, noteStore } = await testWallet({ chain, scanner: scannerYielding([]) });
        await noteStore.save({ version: 1, notes: [storedNote("a", 5n)] });
        expect(await wallet.notes()).toHaveLength(0);
        await wallet.sync({ scope: "notes", reload: true });
        expect(await wallet.notes()).toHaveLength(1);
    });

    it("rejects with the caller's abort reason, and records a failure only for a WalletError", async () => {
        const { wallet } = await testWallet({ chain });
        const ctrl = new AbortController();
        ctrl.abort(new DOMException("gone", "AbortError"));
        await expect(wallet.sync({ scope: "notes", signal: ctrl.signal })).rejects.toBe(
            ctrl.signal.reason,
        );
        expect(wallet.state().sync.lastError).toBeUndefined();
    });
});

describe("balance", () => {
    it("splits the total into spendable and withheld, which add up", async () => {
        const now = new Date().toISOString();
        const notes = [
            // Six spendable notes against a 4-input circuit: two fall into `slots`.
            ...["01", "02", "03", "04", "05", "06"].map((id, i) =>
                storedNote(id, BigInt(100 + i), { firstSeenBlock: 1 }),
            ),
            storedNote("07", 50n, { pendingSpendAt: now, firstSeenBlock: 1 }),
            storedNote("08", 40n, { firstSeenBlock: 100 }), // cooling down at tip 100
            storedNote("09", 30n, { firstSeenBlock: 1 }), // leased below
            storedNote("0a", 999n, { spent: true }),
            storedNote("0b", 70n, { asset: 2n }),
        ];
        const { wallet, internals } = await testWallet({ chain, notes });
        internals.leases.lease(["09"]);

        const b = await wallet.balance(1n);
        const { reserved, cooldown, dust, slots } = b.withheld;
        expect(b.asset.id).toBe(1n);
        expect(b.total).toBe(100n + 101n + 102n + 103n + 104n + 105n + 50n + 40n + 30n);
        expect(b.spendable).toBe(105n + 104n + 103n + 102n);
        expect(reserved).toBe(50n + 30n);
        expect(cooldown).toBe(40n);
        expect(b.total).toBe(b.spendable + reserved + cooldown + dust + slots);
        expect(b.syncedAt).toBeUndefined();
        expect(Object.isFrozen(b)).toBe(true);
    });
});

describe("state and subscribe", () => {
    it("returns one snapshot until a change, then a new immutable one", async () => {
        const { wallet, internals } = await testWallet({
            chain,
            notes: [storedNote("a", 5n), storedNote("b", 7n, { asset: 2n })],
        });
        const s0 = wallet.state();
        expect(wallet.state()).toBe(s0);
        expect(Object.isFrozen(s0)).toBe(true);
        expect(s0.notes).toEqual({ count: 2, unspent: 2, pendingSpend: 0 });
        expect(s0.balances.get(assetId(2n))).toBe(7n);

        await internals.markSpent(["a"]);
        const s1 = wallet.state();
        expect(s1).not.toBe(s0);
        expect(s1.version).toBe(s0.version + 1);
        expect(s1.notes.unspent).toBe(1);
        expect(s0.notes.unspent).toBe(2);
    });

    it("coalesces changes per microtask, never calls on subscribe, and unsubscribes idempotently", async () => {
        const { wallet, internals } = await testWallet({
            chain,
            notes: [storedNote("a"), storedNote("b"), storedNote("c")],
        });
        const seen: WalletState[] = [];
        const unsubscribe = wallet.subscribe((s) => seen.push(s));
        await microtask();
        expect(seen).toHaveLength(0);

        await Promise.all([internals.markSpent(["a"]), internals.markPendingSpend(["b"])]);
        await microtask();
        expect(seen.at(-1)).toBe(wallet.state());
        expect(seen.at(-1)?.notes).toEqual({ count: 3, unspent: 2, pendingSpend: 1 });
        const calls = seen.length;
        expect(calls).toBeLessThanOrEqual(2);

        unsubscribe();
        unsubscribe();
        await internals.markSpent(["c"]);
        await microtask();
        expect(seen).toHaveLength(calls);
    });

    it("delivers one snapshot for any number of synchronous changes", async () => {
        const notes = { notes: [], onChange: () => undefined } as never;
        const store = new WalletStateStore(notes);
        const seen: WalletState[] = [];
        store.subscribe((s) => seen.push(s));
        store.opStarted("a", "transfer");
        store.opPhase("a", "preparing");
        store.opPhase("a", "proving");
        store.opSettled("a");
        store.syncStarted();
        await microtask();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ ops: [], sync: { status: "syncing" } });

        await store.dispose();
        expect(seen.at(-1)?.disposed).toBe(true);
        store.syncStarted();
        await microtask();
        expect(seen.at(-1)?.disposed).toBe(true);
        expect(seen).toHaveLength(2);
    });

    it("logs and swallows a throwing listener, still reaching the others", async () => {
        const { wallet, internals } = await testWallet({ chain, notes: [storedNote("a")] });
        const other = vi.fn();
        wallet.subscribe(() => {
            throw new Error("render bug");
        });
        wallet.subscribe(other);
        await internals.markSpent(["a"]);
        await microtask();
        expect(other).toHaveBeenCalledOnce();
    });

    it("tracks an operation under its opId from start to settle", async () => {
        const { wallet } = await testWallet({ chain });
        const phases: [string, string][] = [];
        const during: WalletState["ops"][] = [];
        const err = await wallet
            .transfer({
                asset: 1n,
                amount: circuitAmount(5n),
                recipient: wallet.address,
                opId: "checkout:42",
                onPhase: (phase, info) => {
                    phases.push([phase, info.opId]);
                    during.push(wallet.state().ops);
                },
            })
            .catch((e: unknown) => e);

        // No notes: the transfer fails at selection, after `preparing`.
        expect(isWalletError(err, "INSUFFICIENT_BALANCE")).toBe(true);
        expect(err).toMatchObject({ context: { opId: "checkout:42", op: "transfer" } });
        expect(phases).toEqual([["preparing", "checkout:42"]]);
        expect(during[0]).toEqual([
            expect.objectContaining({ opId: "checkout:42", op: "transfer", phase: "preparing" }),
        ]);
        expect(wallet.state().ops).toEqual([]);
    });
});

describe("walletInternals", () => {
    it("refuses an object no wallet constructor built", () => {
        let err: unknown;
        try {
            walletInternals({} as never);
        } catch (e) {
            err = e;
        }
        expect(isWalletError(err, "INVALID_ARGUMENT")).toBe(true);
    });

    it("exposes the raw key and stores the object itself does not", async () => {
        const { wallet, internals, noteStore } = await testWallet({ nsk: 11n });
        expect(internals.keys.nsk).toBe(11n);
        expect(internals.noteStore).toBe(noteStore);
        expect(Object.keys(wallet)).not.toContain("noteStore");
    });
});
