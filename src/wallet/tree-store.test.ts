// `TreeStore` builds the local Merkle tree by appending chunk leaves in
// arrival order, so a chunk that does not line up with the tree corrupts every
// leaf after it. These pin the guard that catches that, plus the persistence
// behaviour a sync depends on.

import { describe, expect, it, vi } from "vitest";
import type { Field, Poseidon } from "../crypto/index.js";
import type { CommitmentChunkOut, FmdClient } from "../services/fmd-server/client.js";
import { CHUNK_SIZE } from "./chunk-feed.js";
import { type TreePersistence, TreeStore, type TreeStoreState } from "./tree-store.js";

// Deterministic stub: output depends only on inputs, never on call order.
const MOD = 2n ** 254n;
const stubP: Poseidon = {
    backend: "js",
    hash: (xs: Field[]) => xs.reduce((a, b) => (a * 1000003n + b) % MOD, 1n),
};

/** A chunk whose entries start at `first` and step by `step`. */
function chunk(chunkId: number, first: number, count: number, step = 1): CommitmentChunkOut {
    return {
        chunkId,
        entries: Array.from({ length: count }, (_, i) => ({
            leafIndex: first + i * step,
            leafHash: BigInt(first + i * step + 1),
        })),
        // Short chunks end paging; a full one keeps it going.
        isComplete: count === CHUNK_SIZE,
    };
}

function clientOf(chunks: CommitmentChunkOut[]): FmdClient {
    return {
        fetchCommitmentChunk: async (id: number) => chunks[id] ?? chunk(id, id * CHUNK_SIZE, 0),
    } as unknown as FmdClient;
}

function recordingPersistence(
    initial: TreeStoreState | null = null,
): TreePersistence & { saved: TreeStoreState[]; cleared: number } {
    const saved: TreeStoreState[] = [];
    return {
        saved,
        cleared: 0,
        async load() {
            return initial;
        },
        async save(state) {
            saved.push(state);
        },
        async clear() {
            this.cleared++;
        },
    };
}

describe("TreeStore chunk validation", () => {
    it("accepts a contiguous feed and counts its leaves", async () => {
        const store = new TreeStore(stubP, clientOf([chunk(0, 0, 10)]));

        const summary = await store.sync();

        expect(summary.leavesAdded).toBe(10);
        expect(summary.syncedCount).toBe(10);
    });

    it("rejects a chunk that does not start where the tree ends", async () => {
        // Leaf 0 missing. Appending would put leaf 1 at position 0 and shift
        // every later leaf, silently changing the root.
        const store = new TreeStore(stubP, clientOf([chunk(0, 1, 10)]));

        await expect(store.sync()).rejects.toThrow(/starts at leaf 1, expected 0/);
    });

    it("rejects a chunk with a gap in the middle", async () => {
        const store = new TreeStore(stubP, clientOf([chunk(0, 0, 5, 2)]));

        await expect(store.sync()).rejects.toThrow(/has a gap/);
    });

    it("re-syncing a tail chunk adds nothing and writes nothing", async () => {
        // The tail is re-fetched every sync. Persisting a 1M-leaf tree for a
        // poll that changed nothing is the cost this guard avoids.
        const persistence = recordingPersistence();
        const store = await TreeStore.withPersistence(
            stubP,
            clientOf([chunk(0, 0, 10)]),
            persistence,
        );

        await store.sync();
        const afterFirst = persistence.saved.length;
        const second = await store.sync();

        expect(second.leavesAdded).toBe(0);
        expect(persistence.saved.length).toBe(afterFirst);
    });

    it("persists the node cache, not just the leaves", async () => {
        // Saving before any root() call would snapshot an empty cache and the
        // restore would silently gain nothing.
        const persistence = recordingPersistence();
        const store = await TreeStore.withPersistence(
            stubP,
            clientOf([chunk(0, 0, 10)]),
            persistence,
        );

        await store.sync();

        const state = persistence.saved.at(-1);
        expect(state?.leaves).toHaveLength(10);
        expect(state?.nodes?.length).toBeGreaterThan(0);
    });

    it("restores without recomputing any node", async () => {
        const persistence = recordingPersistence();
        const first = await TreeStore.withPersistence(
            stubP,
            clientOf([chunk(0, 0, 10)]),
            persistence,
        );
        await first.sync();
        const saved = persistence.saved.at(-1)!;
        const want = first.root();

        const counting = { backend: "js", hash: vi.fn(stubP.hash) } as Poseidon;
        const restored = new TreeStore(counting, clientOf([]));
        restored.loadState(saved);
        // The zero-ladder is built in the MerkleTree constructor; only the
        // root() below should be free.
        (counting.hash as ReturnType<typeof vi.fn>).mockClear();

        expect(restored.root()).toBe(want);
        expect(counting.hash).not.toHaveBeenCalled();
    });

    it("keeps partial progress when a later chunk fails", async () => {
        const persistence = recordingPersistence();
        const full = chunk(0, 0, CHUNK_SIZE);
        const client = {
            fetchCommitmentChunk: async (id: number) => {
                if (id === 0) return full;
                throw new Error("network down");
            },
        } as unknown as FmdClient;
        const store = await TreeStore.withPersistence(stubP, client, persistence);

        await expect(store.sync()).rejects.toThrow("network down");

        // The first chunk was already folded in, so dropping it would mean
        // re-downloading and re-hashing it on the next run.
        expect(persistence.saved.at(-1)?.leaves).toHaveLength(CHUNK_SIZE);
    });
});

/** The root a tree holding the first `n` leaves of this feed computes. */
async function rootOf(n: number): Promise<Field> {
    const ref = new TreeStore(stubP, clientOf([chunk(0, 0, n)]));
    await ref.sync();
    return ref.root();
}

/**
 * A client whose chunk feed and `/v1/tree-state` are driven separately.
 *
 * That separation is the point: every case `syncVerified` distinguishes is a
 * disagreement between the two, and a client that derived one from the other
 * could not express any of them.
 */
function twoFeedClient(feed: () => number, state: () => { root: Field; leafCount: number }) {
    return {
        fetchCommitmentChunk: async (id: number) =>
            id === 0 ? chunk(0, 0, feed()) : chunk(id, id * CHUNK_SIZE, 0),
        fetchTreeState: async () => ({ chainId: 31337, frontier: [], ...state() }),
    } as unknown as FmdClient;
}

describe("TreeStore.syncVerified", () => {
    it("settles on the first pass when the tree already agrees", async () => {
        const root = await rootOf(10);
        const persistence = recordingPersistence();
        const store = await TreeStore.withPersistence(
            stubP,
            twoFeedClient(
                () => 10,
                () => ({ root, leafCount: 10 }),
            ),
            persistence,
        );

        const check = await store.syncVerified();

        expect(check.spendable).toBe(true);
        expect(persistence.cleared).toBe(0);
    });

    it("resyncs a tree that is behind, without paying for a rebuild", async () => {
        // The mirror moves while the tree is being built: the chain reports 14
        // leaves against the 10 the feed had served a moment earlier.
        const root14 = await rootOf(14);
        let served = 10;
        const persistence = recordingPersistence();
        const store = await TreeStore.withPersistence(
            stubP,
            twoFeedClient(
                () => served,
                () => {
                    // Reading the chain state is what reveals the feed has moved.
                    served = 14;
                    return { root: root14, leafCount: 14 };
                },
            ),
            persistence,
        );

        const check = await store.syncVerified();

        expect(check.localRoot).toBe(root14);
        expect(check.localLeaves).toBe(14);
        // Appending was enough, so the tree was never thrown away.
        expect(persistence.cleared).toBe(0);
    });

    it("re-reads the chain state before paying for a rebuild", async () => {
        // Equal leaf counts and a differing root is also what two reads taken
        // microseconds apart look like. One GET is worth spending to find out.
        const root = await rootOf(10);
        let reads = 0;
        const persistence = recordingPersistence();
        const store = await TreeStore.withPersistence(
            stubP,
            twoFeedClient(
                () => 10,
                () => ({ root: reads++ === 0 ? 999n : root, leafCount: 10 }),
            ),
            persistence,
        );

        const check = await store.syncVerified();

        expect(check.spendable).toBe(true);
        expect(persistence.cleared).toBe(0);
    });

    it("rebuilds from leaf 0 when the local tree diverged", async () => {
        // A restored tree whose leaves are not the ones the feed serves — the
        // shape a re-indexed server or a redeployed pool leaves behind. The
        // cursor is already past the feed, so syncing appends nothing and only
        // a rebuild can repair it.
        const root = await rootOf(10);
        const persistence = recordingPersistence({
            leaves: Array.from({ length: 10 }, (_, i) => BigInt(1000 + i)),
            syncedCount: 10,
        });
        const store = await TreeStore.withPersistence(
            stubP,
            twoFeedClient(
                () => 10,
                () => ({ root, leafCount: 10 }),
            ),
            persistence,
        );

        const check = await store.syncVerified();

        expect(check.localRoot).toBe(root);
        expect(persistence.cleared).toBe(1);
    });

    it("takes the pool's word over the mirror's, without rebuilding", async () => {
        // The case the whole escalation exists for: a mirror serving a root
        // the chain never held — one built at the wrong depth, say. Rebuilding
        // cannot help, because the local tree was right all along.
        const persistence = recordingPersistence();
        const store = await TreeStore.withPersistence(
            stubP,
            twoFeedClient(
                () => 10,
                () => ({ root: 999n, leafCount: 10 }),
            ),
            persistence,
        );

        const check = await store.syncVerified({ isKnownRoot: async () => true });

        expect(check.spendable).toBe(true);
        // The expensive repair is what the chain read buys back.
        expect(persistence.cleared).toBe(0);
    });

    it("treats an oracle that throws as silence, not permission", async () => {
        const persistence = recordingPersistence();
        const store = await TreeStore.withPersistence(
            stubP,
            twoFeedClient(
                () => 10,
                () => ({ root: 999n, leafCount: 10 }),
            ),
            persistence,
        );

        const check = await store.syncVerified({
            isKnownRoot: async () => {
                throw new Error("rpc down");
            },
        });

        expect(check.spendable).toBe(false);
        expect(persistence.cleared).toBe(1);
    });

    it("reports the mismatch when even a rebuild does not reconcile", async () => {
        // A feed serving leaves that do not add up to the root it advertises.
        // Nothing local can repair that, so it is reported rather than retried.
        const persistence = recordingPersistence();
        const store = await TreeStore.withPersistence(
            stubP,
            twoFeedClient(
                () => 10,
                () => ({ root: 999n, leafCount: 10 }),
            ),
            persistence,
        );

        const check = await store.syncVerified();

        expect(check.spendable).toBe(false);
        expect(check.mirrorRoot).toBe(999n);
        expect(check.localRoot).not.toBe(999n);
        expect(persistence.cleared).toBe(1);
    });
});

describe("TreeStore depth", () => {
    it("builds the tree at the configured depth, not the module default", async () => {
        // The spend path hands `cfg.treeDepth` to the circuit while this used
        // to hardcode 10. A custom preset therefore got depth-10 paths and a
        // depth-12 proof: no error anywhere, the proof simply fails on chain.
        const shallow = new TreeStore(stubP, clientOf([chunk(0, 0, 4)]), 4);
        const deep = new TreeStore(stubP, clientOf([chunk(0, 0, 4)]), 6);

        await shallow.sync();
        await deep.sync();

        // Same leaves, different depth — so a different root, and the path has
        // one entry per level.
        expect(shallow.root()).not.toBe(deep.root());
        expect(shallow.getPath(0).pathIndices).toHaveLength(4);
        expect(deep.getPath(0).pathIndices).toHaveLength(6);
    });

    it("defaults to the deployed depth when none is given", async () => {
        const store = new TreeStore(stubP, clientOf([chunk(0, 0, 4)]));
        await store.sync();
        expect(store.getPath(0).pathIndices).toHaveLength(10);
    });
});
