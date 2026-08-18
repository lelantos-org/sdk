import { describe, expect, it, vi } from "vitest";
import { type Chunk, pageChunks } from "./chunk-feed.js";

// The sliding window is what makes a chunk sync fast: complete chunks are
// CDN-immutable, so fetching eight at a time is nearly free. The cost is that
// the window always overshoots the tail, and everything it started has to be
// accounted for.

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
        // The cap was checked before the refill, so the window speculatively
        // issued up to `FETCH_WINDOW - 1` requests beyond it and abandoned
        // them — real requests, for chunks the caller said it did not want.
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
        // Eight requests are in flight when the tail is seen. Without a signal
        // they all ran to completion with their results discarded — on a
        // browser-tab teardown, twice over, once per feed.
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
