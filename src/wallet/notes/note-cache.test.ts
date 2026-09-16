import { afterEach, describe, expect, it, vi } from "vitest";
import { storedNote } from "../../test-utils/wallet.js";
import { awaitCommitments } from "./note-cache.js";
import type { StoredNote } from "./note-store.js";

// `awaitCommitments` must report which outcome it reached: every commitment seen, the attempt
// cap exhausted, or the wait aborted.

/** A stored note whose commitment is exactly `cm`, which is what the wait matches on. */
const note = (cm: string): StoredNote => ({ ...storedNote(cm), cm });

afterEach(() => vi.useRealTimers());

describe("awaitCommitments", () => {
    it("returns `seen` without polling when everything is already present", async () => {
        const sync = vi.fn(async () => undefined);
        const res = await awaitCommitments(["0xaa"], () => [note("0xaa")], sync);

        expect(res.status).toBe("seen");
        expect(res.missing).toEqual([]);
        expect(sync).not.toHaveBeenCalled();
    });

    it("returns `seen` once a sync brings the commitment in", async () => {
        const store: StoredNote[] = [];
        const res = await awaitCommitments(
            ["0xaa"],
            () => store,
            async () => {
                store.push(note("0xaa"));
            },
            { pollMs: 1 },
        );
        expect(res.status).toBe("seen");
        expect(res.attempts).toBe(1);
    });

    it("reports `timeout` and what is still missing, instead of feigning success", async () => {
        const res = await awaitCommitments(
            ["0xaa", "0xbb"],
            () => [note("0xaa")],
            async () => undefined,
            { pollMs: 1, maxAttempts: 3 },
        );

        expect(res.status).toBe("timeout");
        expect(res.missing).toEqual(["0xbb"]);
        expect(res.attempts).toBe(3);
    });

    it("throws on timeout only when asked", async () => {
        await expect(
            awaitCommitments(
                ["0xaa"],
                () => [],
                async () => undefined,
                {
                    pollMs: 1,
                    maxAttempts: 2,
                    throwOnTimeout: true,
                },
            ),
        ).rejects.toThrow(/not indexed/);
    });

    it("gives up at `timeoutMs`, however many syncs that allowed", async () => {
        vi.useFakeTimers();
        const sync = vi.fn(async () => undefined);
        const pending = awaitCommitments(["0xaa"], () => [], sync, {
            pollMs: 1_000,
            timeoutMs: 3_500,
        });
        await vi.advanceTimersByTimeAsync(10_000);
        const res = await pending;
        expect(res.status).toBe("timeout");
        // Syncs at 0, 1 s, 2 s and 3 s; the last sleep is cut to the 500 ms left.
        expect(sync).toHaveBeenCalledTimes(4);
    });

    it("hands each sync the caller's page size, not a fixed one", async () => {
        const sizes: (number | undefined)[] = [];
        await awaitCommitments(
            ["0xaa"],
            () => [],
            async (pageSize) => {
                sizes.push(pageSize);
            },
            { pollMs: 1, maxAttempts: 2, pageSize: 5_000 },
        );
        await awaitCommitments(
            ["0xaa"],
            () => [],
            async (pageSize) => {
                sizes.push(pageSize);
            },
            { pollMs: 1, maxAttempts: 1 },
        );
        expect(sizes).toEqual([5_000, 5_000, undefined]);
    });

    it("distinguishes an abort from a timeout", async () => {
        const ctrl = new AbortController();
        const res = await awaitCommitments(
            ["0xaa"],
            () => [],
            async () => {
                ctrl.abort();
            },
            { pollMs: 5, maxAttempts: 10, signal: ctrl.signal },
        );
        expect(res.status).toBe("aborted");
        expect(res.missing).toEqual(["0xaa"]);
    });

    it("is matched case-insensitively", async () => {
        const res = await awaitCommitments(
            ["0xAA"],
            () => [note("0xaa")],
            async () => undefined,
        );
        expect(res.status).toBe("seen");
    });
});
