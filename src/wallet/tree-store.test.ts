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

function recordingPersistence(): TreePersistence & { saved: TreeStoreState[] } {
    const saved: TreeStoreState[] = [];
    return {
        saved,
        async load() {
            return null;
        },
        async save(state) {
            saved.push(state);
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

        const counting = { hash: vi.fn(stubP.hash) } as Poseidon;
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
