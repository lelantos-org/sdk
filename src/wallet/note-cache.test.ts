import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitCommitments } from "./note-cache.js";
import type { StoredNote } from "./note-store.js";

// The old version looped up to 30 times and then returned normally whether
// or not the commitments had arrived, so "the indexer is behind" was
// indistinguishable from success. Its internal sleep also resolved plainly
// on abort, making a cancelled wait look like a completed one.

function note(cm: string): StoredNote {
    return {
        id: cm,
        asset: "1",
        value: "1",
        rho: "0",
        rcm: "0",
        rcvDep: "0",
        cm,
        leafIndex: 0,
        spent: false,
        discoveredAt: "1970-01-01T00:00:00Z",
    };
}

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
