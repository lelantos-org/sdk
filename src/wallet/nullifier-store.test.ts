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
