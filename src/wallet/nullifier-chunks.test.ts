import { describe, expect, it, vi } from "vitest";
import type { FmdClient, NullifierChunkOut } from "../services/fmd-server/client.js";
import { CHUNK_SIZE } from "./chunk-feed.js";
import { NullifierStore } from "./nullifier-store.js";

// The fold implies position: a chunk's k-th entry has sequence
// `chunkId * CHUNK_SIZE + k`, and `syncedCount` advances by the chunk's own
// length. Nothing checked that the server agreed, and the failure is silent.

const full = (chunkId: number, isComplete = true): NullifierChunkOut => ({
    chunkId,
    isComplete,
    nullifiers: Array.from({ length: CHUNK_SIZE }, (_, k) => BigInt(chunkId * CHUNK_SIZE + k + 1)),
});

function storeOver(chunks: (id: number) => NullifierChunkOut) {
    const fetchNullifierChunk = vi.fn(async (chunkId: number) => chunks(chunkId));
    const fmd = { fetchNullifierChunk } as unknown as FmdClient;
    return { store: new NullifierStore(fmd), fetchNullifierChunk };
}

describe("NullifierStore chunk validation", () => {
    it("folds a well-formed feed", async () => {
        const { store } = storeOver((id) => (id === 0 ? full(0) : full(1, false)));
        const summary = await store.sync();

        expect(summary.stoppedBy).toBe("complete");
        expect(store.size).toBe(2 * CHUNK_SIZE);
    });

    it("rejects an over-long chunk instead of skipping real entries", async () => {
        // An over-long chunk pushes `syncedCount` into the next chunk's range,
        // so the next fold's `slice` drops that many genuine nullifiers. Their
        // notes are then never marked spent and the selector keeps offering
        // them — relayer rejections forever, with nothing to point at.
        const { store } = storeOver((id) => {
            const c = full(id, false);
            return { ...c, nullifiers: [...c.nullifiers, 999_999n] };
        });

        await expect(store.sync()).rejects.toThrow(/at most/);
    });

    it("rejects a chunk that is not the one requested", async () => {
        const { store } = storeOver(() => full(7, false));
        await expect(store.sync()).rejects.toThrow(/expected 0/);
    });

    it("rejects a short chunk that claims to be complete", async () => {
        const { store } = storeOver((id) => ({ ...full(id), nullifiers: [1n, 2n] }));
        await expect(store.sync()).rejects.toThrow(/marked complete/);
    });

    it("rejects an untruncated entry, which every lookup would miss", async () => {
        // Entries arrive truncated to 10 bytes; `has()` truncates its argument.
        // A full-width entry is stored full-width and never matches, so no note
        // is ever marked spent — silently, and in the unsafe direction.
        const { store } = storeOver((id) => ({
            ...full(id, false),
            nullifiers: [1n << 200n],
        }));

        await expect(store.sync()).rejects.toThrow(/wider than/);
    });
});
