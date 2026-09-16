// `TreeStore` appends chunk leaves in arrival order, so a misaligned chunk corrupts every later
// leaf. These tests cover the alignment check and the persistence behaviour sync depends on.

import { describe, expect, it, vi } from "vitest";
import type { Field, Poseidon } from "../crypto/index.js";
import type { CommitmentChunkOut, FmdClient } from "../services/fmd-server/index.js";
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
        // Short chunks end paging; full chunks continue it.
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
        // Leaf 0 is missing; appending would shift every later leaf and change the root.
        const store = new TreeStore(stubP, clientOf([chunk(0, 1, 10)]));

        await expect(store.sync()).rejects.toThrow(/starts at leaf 1, expected 0/);
    });

    it("rejects a chunk with a gap in the middle", async () => {
        const store = new TreeStore(stubP, clientOf([chunk(0, 0, 5, 2)]));

        await expect(store.sync()).rejects.toThrow(/has a gap/);
    });

    it("re-syncing a tail chunk adds nothing and writes nothing", async () => {
        // The tail is re-fetched every sync; a poll that adds nothing must not persist the tree.
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
        // Saving before any root() call would snapshot an empty node cache.
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
        // The zero-ladder is built in the MerkleTree constructor; root() below must not hash.
        (counting.hash as ReturnType<typeof vi.fn>).mockClear();

        expect(restored.root()).toBe(want);
        expect(counting.hash).not.toHaveBeenCalled();
    });

    it("saves nothing for a failed sync, and persists its progress on the next success", async () => {
        const persistence = recordingPersistence();
        const full = chunk(0, 0, CHUNK_SIZE);
        let down = true;
        const client = {
            fetchCommitmentChunk: async (id: number) => {
                if (id === 0) return full;
                if (down) throw new Error("network down");
                return chunk(id, id * CHUNK_SIZE, 0);
            },
        } as unknown as FmdClient;
        const store = await TreeStore.withPersistence(stubP, client, persistence);

        await expect(store.sync()).rejects.toThrow("network down");
        // Saving here could replace the sync's error with the save's.
        expect(persistence.saved).toHaveLength(0);

        down = false;
        const next = await store.sync();
        // The first chunk was already folded in memory, so this sync adds nothing, yet it still
        // persists what the failed one fetched.
        expect(next.leavesAdded).toBe(0);
        expect(persistence.saved.at(-1)?.leaves).toHaveLength(CHUNK_SIZE);
    });

    it("reports a failed save with the storage error as its cause", async () => {
        const storage = new Error("quota exceeded");
        const persistence: TreePersistence = {
            load: async () => null,
            save: async () => {
                throw storage;
            },
            clear: async () => {},
        };
        const store = await TreeStore.withPersistence(
            stubP,
            clientOf([chunk(0, 0, 10)]),
            persistence,
        );

        const err = await store.sync().catch((e: unknown) => e);
        expect(err).toMatchObject({ code: "ENVIRONMENT", cause: storage });
        // The in-memory tree is still current.
        expect(store.saveState().syncedCount).toBe(10);
    });
});

describe("TreeStore concurrency", () => {
    /** A feed whose chunk 1 waits for `release()`, so a sync can be caught mid-page. */
    function gatedClient() {
        let release!: () => void;
        const gate = new Promise<void>((r) => {
            release = r;
        });
        let fetched1!: () => void;
        const reached = new Promise<void>((r) => {
            fetched1 = r;
        });
        const client = {
            fetchCommitmentChunk: async (id: number) => {
                if (id === 0) return chunk(0, 0, CHUNK_SIZE);
                if (id === 1) {
                    fetched1();
                    await gate;
                    return chunk(1, CHUNK_SIZE, 3);
                }
                return chunk(id, id * CHUNK_SIZE, 0);
            },
        } as unknown as FmdClient;
        return { client, release, reached };
    }

    it("does not let a reset land in the middle of a paging sync", async () => {
        const { client, release, reached } = gatedClient();
        const store = new TreeStore(stubP, client);

        const syncing = store.sync();
        await reached;
        // Unserialised, the reset empties the tree while chunk 1 is in flight, and chunk 1 then
        // "starts at leaf 1024, expected 0".
        const resetting = store.reset();
        release();

        await expect(syncing).resolves.toMatchObject({ syncedCount: CHUNK_SIZE + 3 });
        await resetting;
        expect(store.saveState().syncedCount).toBe(0);
    });

    it("lands saves in sync order", async () => {
        const order: number[] = [];
        let slowFirst = true;
        const persistence: TreePersistence = {
            load: async () => null,
            save: async (state) => {
                if (slowFirst) {
                    slowFirst = false;
                    await new Promise((r) => setTimeout(r, 20));
                }
                order.push(state.syncedCount);
            },
            clear: async () => {},
        };
        // The first sync sees 10 leaves, every later one 12.
        let fetches = 0;
        const client = {
            fetchCommitmentChunk: async (id: number) =>
                id === 0 ? chunk(0, 0, fetches++ === 0 ? 10 : 12) : chunk(id, id * CHUNK_SIZE, 0),
        } as unknown as FmdClient;
        const store = await TreeStore.withPersistence(stubP, client, persistence);

        const first = store.sync();
        const second = store.sync();
        await Promise.all([first, second]);

        // An older snapshot saved last would roll the persisted tree back.
        expect(order).toEqual([10, 12]);
    });

    it("reads a spend's root and paths from the tree it verified", async () => {
        const root = await rootOf(10);
        let served = 10;
        const store = new TreeStore(
            stubP,
            twoFeedClient(
                () => served,
                () => ({ root, leafCount: 10 }),
            ),
        );

        const { check, value } = await store.syncVerifiedSnapshot({}, async () => {
            // A sync queued while the snapshot is open must not move the tree under it.
            served = 14;
            void store.sync();
            await new Promise((r) => setTimeout(r, 5));
            return { root: store.root(), pathRoot: store.getPath(3).root };
        });

        expect(check.spendable).toBe(true);
        expect(value).toEqual({ root: check.localRoot, pathRoot: check.localRoot });
        await store.sync();
        expect(store.root()).not.toBe(root);
    });

    it("skips the read when the tree cannot be verified", async () => {
        const store = new TreeStore(
            stubP,
            twoFeedClient(
                () => 10,
                () => ({ root: 999n, leafCount: 10 }),
            ),
        );
        const read = vi.fn(() => 1);

        const { check, value } = await store.syncVerifiedSnapshot({}, read);

        expect(check.spendable).toBe(false);
        expect(value).toBeUndefined();
        expect(read).not.toHaveBeenCalled();
    });
});

/** The root a tree holding the first `n` leaves of this feed computes. */
async function rootOf(n: number): Promise<Field> {
    const ref = new TreeStore(stubP, clientOf([chunk(0, 0, n)]));
    await ref.sync();
    return ref.root();
}

/**
 * Client whose chunk feed and `/v1/tree-state` are driven independently, since every case
 * `syncVerified` distinguishes is a disagreement between the two.
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
        // The mirror advances during the build: tree state reports 14 leaves, the feed served 10.
        const root14 = await rootOf(14);
        let served = 10;
        const persistence = recordingPersistence();
        const store = await TreeStore.withPersistence(
            stubP,
            twoFeedClient(
                () => served,
                () => {
                    // The feed advances once the tree state is read.
                    served = 14;
                    return { root: root14, leafCount: 14 };
                },
            ),
            persistence,
        );

        const check = await store.syncVerified();

        expect(check.localRoot).toBe(root14);
        expect(check.localLeaves).toBe(14);
        // Appending suffices, so the tree is not cleared.
        expect(persistence.cleared).toBe(0);
    });

    it("re-reads the chain state before paying for a rebuild", async () => {
        // Equal leaf counts with a differing root can result from two reads taken at slightly
        // different times.
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
        // A restored tree whose leaves differ from the feed (e.g. after a server re-index or pool
        // redeploy). The cursor is already past the feed, so only a rebuild can repair it.
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
        // A mirror serving a root the chain never held (e.g. built at the wrong depth). The local
        // tree is correct, so rebuilding cannot help.
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
        // The chain read avoids the rebuild.
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
        // A feed whose leaves do not produce its advertised root cannot be repaired locally, so the
        // mismatch is reported.
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
        // The spend path passes `cfg.treeDepth` to the circuit, so the tree must use that depth; a
        // mismatch raises no error but the proof fails on-chain.
        const shallow = new TreeStore(stubP, clientOf([chunk(0, 0, 4)]), 4);
        const deep = new TreeStore(stubP, clientOf([chunk(0, 0, 4)]), 6);

        await shallow.sync();
        await deep.sync();

        // Same leaves at different depths yield different roots and one path entry per level.
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
