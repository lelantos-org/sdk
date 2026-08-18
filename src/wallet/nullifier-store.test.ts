import { describe, expect, it, vi } from "vitest";
import type { FmdClient, NullifierChunkOut } from "../services/fmd-server/client.js";
import { CHUNK_SIZE } from "./chunk-feed.js";
import { NullifierStore } from "./nullifier-store.js";

// The tail chunk is re-fetched on every sync, so the cursor is the only thing
// keeping a resumed sync from double-counting. These tests pin that: the set
// contents, the cursor, and the reported `added` must all survive a partial
// tail growing into a complete one.

/**
 * A fake server holding `total` nullifiers, numbered `1..total`. `FmdClient`
 * decodes hex at its own boundary, so this stands in downstream of that and
 * hands back the decoded values — truncated ones, as the server sends them,
 * though these are small enough that truncation is a no-op.
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

        // Same chunk 0, now grown from 10 entries to 12. The first 10 come
        // back on the wire again and must not advance `added` a second time.
        server.grow(12);
        server.chunk.mockClear();
        const summary = await store.sync();

        expect(summary.added).toBe(2);
        expect(summary.syncedCount).toBe(12);
        expect(store.size).toBe(12);
        // Chunk id is what matters; the second argument is the abort signal
        // `pageChunks` threads through so an abandoned window is cancelled.
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
        // Resuming re-reads only the tail chunk, and adds nothing new.
        expect((await restored.sync()).added).toBe(0);
    });

    it("truncates the queried nullifier to the width the server sends", async () => {
        // The mirror holds low-10-byte slices, so a full-width nullifier only
        // ever matches through the same truncation. Without it every `has`
        // returns false and the wallet believes nothing was ever spent.
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
