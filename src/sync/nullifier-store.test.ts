import { describe, expect, it, vi } from "vitest";
import type { FmdClient, NullifierChunkOut } from "../services/fmd-server/index.js";
import { CHUNK_SIZE } from "./chunk-feed.js";
import { NullifierStore } from "./nullifier-store.js";

// The tail chunk is re-fetched on every sync, so the cursor alone prevents double-counting. The
// set contents, cursor and reported `added` must stay correct as a partial tail becomes complete.

/**
 * Fake server holding `total` nullifiers numbered `1..total`. Returns decoded values as
 * `FmdClient` would; they are small enough that truncation is a no-op.
 */
function fakeFmd(initialTotal: number) {
    let total = initialTotal;
    const chunk = vi.fn(async (chunkId: number): Promise<NullifierChunkOut> => {
        const base = chunkId * CHUNK_SIZE;
        const count = Math.max(0, Math.min(CHUNK_SIZE, total - base));
        return {
            chunkId,
            nullifiers: Array.from({ length: count }, (_, i) => BigInt(base + i + 1)),
            isComplete: count === CHUNK_SIZE,
        };
    });
    return {
        fmd: { fetchNullifierChunk: chunk } as unknown as FmdClient,
        chunk,
        grow: (to: number) => {
            total = to;
        },
    };
}

describe("NullifierStore.sync", () => {
    it("pages until the tail chunk and mirrors every nullifier", async () => {
        const { fmd } = fakeFmd(CHUNK_SIZE * 2 + 5);
        const store = new NullifierStore(fmd);

        const summary = await store.sync();

        expect(summary.stoppedBy).toBe("complete");
        expect(summary.syncedCount).toBe(CHUNK_SIZE * 2 + 5);
        expect(store.size).toBe(CHUNK_SIZE * 2 + 5);
        expect(store.has(1n)).toBe(true);
        expect(store.has(BigInt(CHUNK_SIZE * 2 + 5))).toBe(true);
        expect(store.has(BigInt(CHUNK_SIZE * 2 + 6))).toBe(false);
    });

    it("re-fetches the partial tail without double-counting what it already holds", async () => {
        const server = fakeFmd(10);
        const store = new NullifierStore(server.fmd);
        expect((await store.sync()).added).toBe(10);

        // Chunk 0 grows from 10 to 12 entries; the 10 re-sent entries must not count again.
        server.grow(12);
        server.chunk.mockClear();
        const summary = await store.sync();

        expect(summary.added).toBe(2);
        expect(summary.syncedCount).toBe(12);
        expect(store.size).toBe(12);
        // Only the chunk id is checked; the second argument is the abort signal from `pageChunks`.
        expect(server.chunk.mock.calls.map((c) => c[0])).toContain(0);
    });

    it("stops at `maxChunks` and says so rather than paging forever", async () => {
        const { fmd } = fakeFmd(CHUNK_SIZE * 10);
        const store = new NullifierStore(fmd);

        const summary = await store.sync({ maxChunks: 3 });

        expect(summary.stoppedBy).toBe("maxChunks");
        expect(summary.chunksFetched).toBe(3);
        expect(store.size).toBe(CHUNK_SIZE * 3);
    });

    it("round-trips through persistence", async () => {
        const { fmd } = fakeFmd(7);
        let saved: ReturnType<NullifierStore["saveState"]> | null = null;
        const persistence = {
            load: async () => saved,
            save: async (s: ReturnType<NullifierStore["saveState"]>) => {
                saved = s;
            },
        };

        await (await NullifierStore.withPersistence(fmd, persistence)).sync();
        const restored = await NullifierStore.withPersistence(fmd, persistence);

        expect(restored.size).toBe(7);
        expect(restored.has(7n)).toBe(true);
        // Resuming re-reads only the tail chunk and adds nothing.
        expect((await restored.sync()).added).toBe(0);
    });

    it("truncates the queried nullifier to the width the server sends", async () => {
        // The mirror holds low-10-byte slices, so a full-width nullifier matches only after the
        // same truncation.
        const { fmd } = fakeFmd(3);
        const store = new NullifierStore(fmd);
        await store.sync();

        const highBits = 0x1234n << 80n;
        expect(store.has(highBits + 2n)).toBe(true);
        expect(store.has(highBits + 4n)).toBe(false);
    });

    it("stops paging when aborted", async () => {
        const { fmd, chunk } = fakeFmd(CHUNK_SIZE * 4);
        const store = new NullifierStore(fmd);

        const summary = await store.sync({ signal: AbortSignal.abort() });

        expect(summary.stoppedBy).toBe("aborted");
        expect(chunk).not.toHaveBeenCalled();
        expect(store.size).toBe(0);
    });
});

// The fold implies position: a chunk's k-th entry has sequence `chunkId * CHUNK_SIZE + k`, and
// `syncedCount` advances by the chunk's length. These tests check that malformed chunks are
// rejected.

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
        // An over-long chunk pushes `syncedCount` into the next chunk's range, so the next fold's
        // `slice` would drop that many genuine nullifiers and their notes would never be spent.
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
        // Entries arrive truncated to 10 bytes and `has()` truncates its argument, so a full-width
        // entry would never match.
        const { store } = storeOver((id) => ({
            ...full(id, false),
            nullifiers: [1n << 200n],
        }));

        await expect(store.sync()).rejects.toThrow(/wider than/);
    });
});
