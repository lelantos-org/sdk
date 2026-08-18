import { describe, expect, it, vi } from "vitest";
import type { WorkerLike } from "../../worker/types.js";
import type { ScanInput } from "../scan.js";
import { WorkerPoolScanner } from "./pool.js";

// A worker handles its messages serially, so how work is dispatched decides
// whether the per-scan timeout measures work or queueing.

/**
 * Worker double that answers `init` and `scan` over the real RPC wire format.
 * `onScan` observes concurrency; resolve its returned promise to release.
 */
function fakeWorker(hooks: {
    onScan?: (leafFrom: number) => Promise<void>;
    failInit?: boolean;
}): WorkerLike {
    const w = {
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        onerror: null,
        onmessageerror: null,
        terminate: vi.fn(),
        postMessage(msg: unknown) {
            const req = msg as { id: number; method: string; params: Record<string, never> };
            if (req.method === undefined) return; // log-config control frame
            void (async () => {
                if (req.method === "init") {
                    if (hooks.failInit) {
                        w.onmessage?.({
                            data: {
                                id: req.id,
                                ok: false,
                                error: { name: "Error", message: "wasm boot failed" },
                            },
                        });
                        return;
                    }
                    w.onmessage?.({ data: { id: req.id, ok: true, result: undefined } });
                    return;
                }
                const params = req.params as unknown as { inputs: { leafIndex: number }[] };
                await hooks.onScan?.(params.inputs[0]?.leafIndex ?? -1);
                w.onmessage?.({ data: { id: req.id, ok: true, result: { hits: [] } } });
            })();
        },
    };
    return w as unknown as WorkerLike;
}

const inputs = (count: number): ScanInput[] =>
    Array.from({ length: count }, (_, i) => ({
        ciphertext: new Uint8Array(2),
        epk: new Uint8Array(32),
        cm: BigInt(i),
        leafIndex: i,
        blockNumber: 1,
    }));

describe("WorkerPoolScanner dispatch", () => {
    it("keeps at most one scan in flight per worker", async () => {
        // Every chunk used to be posted at once, so a slot could hold several
        // scans all sharing one timeout while queued behind each other — and a
        // chunk that had done no work yet would time out, taking a healthy
        // worker with it via `recycle`.
        let inFlight = 0;
        let peak = 0;
        const release: Array<() => void> = [];

        const scanner = new WorkerPoolScanner({
            size: 2,
            chunkSize: 1,
            factory: () =>
                fakeWorker({
                    onScan: async () => {
                        inFlight++;
                        peak = Math.max(peak, inFlight);
                        await new Promise<void>((r) => release.push(r));
                        inFlight--;
                    },
                }),
        });

        let settled = false;
        const scanning = scanner.scan(1n, inputs(8)).finally(() => {
            settled = true;
        });
        // Drain: release whatever is parked, tick, repeat until the scan ends.
        for (let i = 0; i < 200 && !settled; i++) {
            for (const r of release.splice(0)) r();
            await new Promise((r) => setTimeout(r, 0));
        }
        await scanning;

        expect(peak).toBeLessThanOrEqual(2);
        await scanner.dispose();
    });

    it("processes every chunk exactly once", async () => {
        const seen: number[] = [];
        const scanner = new WorkerPoolScanner({
            size: 3,
            chunkSize: 1,
            factory: () =>
                fakeWorker({
                    onScan: async (leafFrom) => {
                        seen.push(leafFrom);
                    },
                }),
        });

        await scanner.scan(1n, inputs(7));

        expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
        await scanner.dispose();
    });

    it("does not leave an init rejection unobserved when no scan follows", async () => {
        // `ready` is only awaited inside `runChunk`, so a pool that is never
        // scanned — or is disposed first — used to trip Node's
        // `unhandledRejection`.
        const unhandled: unknown[] = [];
        const onUnhandled = (err: unknown) => unhandled.push(err);
        process.on("unhandledRejection", onUnhandled);
        try {
            const scanner = new WorkerPoolScanner({
                size: 2,
                factory: () => fakeWorker({ failInit: true }),
            });
            await new Promise((r) => setTimeout(r, 10));
            await scanner.dispose();
            await new Promise((r) => setTimeout(r, 10));
        } finally {
            process.off("unhandledRejection", onUnhandled);
        }

        expect(unhandled).toEqual([]);
    });

    it("still surfaces the init failure to a scan", async () => {
        const scanner = new WorkerPoolScanner({
            size: 1,
            factory: () => fakeWorker({ failInit: true }),
        });

        await expect(scanner.scan(1n, inputs(1))).rejects.toThrow(/wasm boot failed/);
        await scanner.dispose();
    });
});
