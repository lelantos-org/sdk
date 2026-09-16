import { describe, expect, it, vi } from "vitest";
import { type Chunk, pageChunks } from "./chunk-feed.js";

// The sliding window fetches up to eight CDN-immutable chunks in parallel. It overshoots the
// tail, so every request it starts must be bounded and cancelled.

const chunk = (chunkId: number, isComplete: boolean): Chunk => ({ chunkId, isComplete });

/** Feed of `completeCount` complete chunks, then an incomplete tail. */
function feed(completeCount: number) {
    const started: number[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const fetchChunk = vi.fn(async (chunkId: number, signal?: AbortSignal) => {
        started.push(chunkId);
        signals.push(signal);
        return chunk(chunkId, chunkId < completeCount);
    });
    return { fetchChunk, started, signals };
}

describe("pageChunks", () => {
    it("consumes in ascending order and stops at the incomplete tail", async () => {
        const { fetchChunk } = feed(3);
        const seen: number[] = [];

        const summary = await pageChunks(fetchChunk, 0, (c) => seen.push(c.chunkId), {
            feed: "test",
        });

        expect(summary.stoppedBy).toBe("complete");
        expect(seen).toEqual([0, 1, 2, 3]);
    });

    it("never requests a chunk past the cap", async () => {
        // The refill must not issue speculative requests beyond `maxChunks`.
        const { fetchChunk, started } = feed(1000);

        const summary = await pageChunks(fetchChunk, 0, () => {}, {
            feed: "test",
            maxChunks: 3,
        });

        expect(summary.stoppedBy).toBe("maxChunks");
        expect(summary.chunksFetched).toBe(3);
        expect(Math.max(...started)).toBeLessThanOrEqual(2);
    });

    it("respects the cap when resuming from a later chunk", async () => {
        const { fetchChunk, started } = feed(1000);

        await pageChunks(fetchChunk, 10, () => {}, { feed: "test", maxChunks: 2 });

        expect(started.every((id) => id >= 10 && id <= 11)).toBe(true);
    });

    it("cancels the abandoned tail of the window", async () => {
        // Up to eight requests are in flight when the tail is seen; all must be
        // aborted rather than run to completion.
        const { fetchChunk, signals } = feed(0);

        await pageChunks(fetchChunk, 0, () => {}, { feed: "test" });

        expect(signals.length).toBeGreaterThan(1);
        expect(signals.every((s) => s?.aborted)).toBe(true);
    });

    it("reports an abort and cancels what it started", async () => {
        const ctrl = new AbortController();
        const { fetchChunk, signals } = feed(1000);

        const summary = await pageChunks(
            fetchChunk,
            0,
            (c) => {
                if (c.chunkId === 1) ctrl.abort(new Error("tab closed"));
            },
            { feed: "test", signal: ctrl.signal },
        );

        expect(summary.stoppedBy).toBe("aborted");
        expect(signals.every((s) => s?.aborted)).toBe(true);
    });

    it("cancels the window when consume throws", async () => {
        const { fetchChunk, signals } = feed(1000);

        await expect(
            pageChunks(
                fetchChunk,
                0,
                () => {
                    throw new Error("bad chunk");
                },
                { feed: "test" },
            ),
        ).rejects.toThrow("bad chunk");

        expect(signals.every((s) => s?.aborted)).toBe(true);
    });
});
