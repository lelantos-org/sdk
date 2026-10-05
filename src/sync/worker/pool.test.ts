import { describe, expect, it, vi } from "vitest";
import { sealOutput } from "../../bundle/common.js";
import { Jubjub } from "../../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../../crypto/poseidon.js";
import { buildSpendingKey } from "../../keys/keys.js";
import { configureLogging } from "../../log/logger.js";
import type { WorkerLike } from "../../runtime/rpc/types.js";
import { recipientAt, sealedScanInput } from "../../test-utils/outputs.js";
import { emptyScanStats, type ScanHit, type ScanInput, type ScanStats } from "../scan.js";
import { WorkerPoolScanner } from "./pool.js";
import {
    decodeHit,
    decodeInput,
    encodeHit,
    encodeInput,
    transferablesOf,
    type WireScanHit,
    type WireScanInput,
} from "./protocol.js";

// A worker handles its messages serially, so how work is dispatched decides
// whether the per-scan timeout measures work or queueing.

/**
 * Worker double that answers `init` and `scan` over the real RPC wire format.
 * `onScan` observes concurrency; resolve its returned promise to release.
 * `answer` sees each scan request as posted, with its transfer list, and supplies the hits.
 * `tally` supplies the request's stats; by default every input is scanned and none is counted.
 */
function fakeWorker(hooks: {
    onScan?: (leafFrom: number) => Promise<void>;
    answer?: (inputs: WireScanInput[], transfer: readonly unknown[]) => WireScanHit[];
    tally?: (inputs: WireScanInput[]) => ScanStats;
    failInit?: boolean;
    failScan?: () => boolean;
}): WorkerLike {
    const w = {
        onmessage: null as ((ev: { data: unknown }) => void) | null,
        onerror: null,
        onmessageerror: null,
        terminate: vi.fn(),
        postMessage(msg: unknown, transfer: readonly unknown[] = []) {
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
                const params = req.params as unknown as { inputs: WireScanInput[] };
                await hooks.onScan?.(params.inputs[0]?.leafIndex ?? -1);
                if (hooks.failScan?.()) {
                    w.onmessage?.({
                        data: {
                            id: req.id,
                            ok: false,
                            error: { name: "Error", message: "scan failed" },
                        },
                    });
                    return;
                }
                const hits = hooks.answer?.(params.inputs, transfer) ?? [];
                const stats = hooks.tally?.(params.inputs) ?? {
                    ...emptyScanStats(),
                    scanned: params.inputs.length,
                };
                w.onmessage?.({ data: { id: req.id, ok: true, result: { hits, stats } } });
            })();
        },
    };
    return w as unknown as WorkerLike;
}

const inputs = (count: number): ScanInput[] =>
    Array.from({ length: count }, (_, i) => ({
        ciphertext: new Uint8Array(2),
        epk: new Uint8Array(32),
        clueR: new Uint8Array(32),
        cm: BigInt(i),
        leafIndex: i,
        blockNumber: 1,
    }));

describe("WorkerPoolScanner dispatch", () => {
    it("keeps at most one scan in flight per worker", async () => {
        // Several scans queued on one slot share its timeout, so a chunk that
        // has done no work can time out and `recycle` a healthy worker.
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
        // `ready` is awaited only inside `runChunk`, so a pool that is never scanned, or is
        // disposed first, must not trip Node's `unhandledRejection`.
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

// The scan checks run inside the worker, so the clue point must reach it and the diversifier of
// each hit must come back.

/** A diversifier that needs all 16 bytes. */
const D = (1n << 128n) - 5n;

const scanInput = (): ScanInput => ({
    ciphertext: Uint8Array.from({ length: 114 }, (_, i) => i),
    epk: new Uint8Array(32).fill(0xe1),
    clueR: Uint8Array.from({ length: 32 }, (_, i) => 0xc0 + i),
    cm: (1n << 250n) + 7n,
    leafIndex: 11,
    blockNumber: 22,
});

const scanHit = (): ScanHit => ({
    asset: 1n,
    value: 500n,
    rho: (1n << 253n) + 1n,
    rcm: (1n << 252n) + 2n,
    d: D,
    cm: (1n << 250n) + 7n,
    leafIndex: 11,
    blockNumber: 22,
});

describe("scanner wire codec", () => {
    it("round-trips an input with its clue point", () => {
        const wire = encodeInput(scanInput());

        expect(wire.clueR).toEqual(scanInput().clueR);
        expect(decodeInput(wire)).toEqual(scanInput());
    });

    it("transfers the clue point's buffer with the ciphertext's and the ephemeral key's", () => {
        const wire = encodeInput(scanInput());
        const transfer = transferablesOf([wire]);

        expect(transfer).toEqual([wire.ciphertext.buffer, wire.epk.buffer, wire.clueR.buffer]);

        // A real transfer: the receiving side holds the bytes, the sender's views are detached.
        const received = structuredClone(wire, { transfer: transfer as ArrayBuffer[] });

        expect(decodeInput(received)).toEqual(scanInput());
        expect(wire.clueR.byteLength).toBe(0);
        expect(wire.epk.byteLength).toBe(0);
        expect(wire.ciphertext.byteLength).toBe(0);
    });

    it("round-trips a hit with its diversifier as a decimal string", () => {
        const wire = encodeHit(scanHit());

        expect(wire.d).toBe("340282366920938463463374607431768211451");
        // Through a structured clone and through JSON: no bigint crosses.
        expect(decodeHit(structuredClone(wire))).toEqual(scanHit());
        expect(decodeHit(JSON.parse(JSON.stringify(wire)))).toEqual(scanHit());
    });
});

describe("WorkerPoolScanner round-trip", () => {
    it("hands the worker each clue point and returns each hit's diversifier", async () => {
        const seen: WireScanInput[] = [];
        const transferred: unknown[] = [];
        const scanner = new WorkerPoolScanner({
            size: 1,
            factory: () =>
                fakeWorker({
                    answer: (wireInputs, transfer) => {
                        seen.push(...wireInputs);
                        transferred.push(...transfer);
                        return wireInputs.map((w) => encodeHit({ ...scanHit(), cm: BigInt(w.cm) }));
                    },
                }),
        });

        const first = scanInput();
        const second = { ...scanInput(), clueR: new Uint8Array(32).fill(0x5a), cm: 9n };
        const hits = await scanner.scan(1n, [first, second]);

        expect(seen.map((w) => w.clueR)).toEqual([scanInput().clueR, second.clueR]);
        expect(transferred).toContain(first.clueR.buffer);
        expect(transferred).toContain(second.clueR.buffer);
        expect(hits).toEqual([scanHit(), { ...scanHit(), cm: 9n }]);
        expect(hits.every((h) => h.d === D)).toBe(true);
        await scanner.dispose();
    });
});

// The tallies are how a caller tells an empty result from a feed whose notes fail a check; they
// are counted inside each worker.
describe("WorkerPoolScanner tallies", () => {
    it("sums every worker's tallies, chunk by chunk, into lastStats", async () => {
        // Each chunk reports its inputs' leaf indices as tallies, so every field is exercised
        // with a value no other field has.
        const tally = (wire: WireScanInput[]): ScanStats => {
            const leaves = wire.reduce((sum, w) => sum + w.leafIndex, 0);
            return {
                scanned: wire.length,
                notOurs: leaves,
                decodeFailed: 2 * leaves,
                zeroValue: 3 * leaves,
                cmMismatch: 4 * leaves,
                ephemeralMismatch: 5 * leaves,
                clueMismatch: 6 * leaves,
                hits: 7 * leaves,
            };
        };
        const scanner = new WorkerPoolScanner({
            size: 3,
            chunkSize: 2,
            factory: () => fakeWorker({ tally }),
        });
        expect(scanner.lastStats).toEqual(emptyScanStats());

        await scanner.scan(1n, inputs(7));

        // Leaves 0..6 sum to 21.
        expect(scanner.lastStats).toEqual({
            scanned: 7,
            notOurs: 21,
            decodeFailed: 42,
            zeroValue: 63,
            cmMismatch: 84,
            ephemeralMismatch: 105,
            clueMismatch: 126,
            hits: 147,
        });
        await scanner.dispose();
    });

    it("reports the most recent scan only", async () => {
        let failing = false;
        const scanner = new WorkerPoolScanner({
            size: 2,
            factory: () => fakeWorker({ failScan: () => failing }),
        });

        await scanner.scan(1n, inputs(5));
        expect(scanner.lastStats.scanned).toBe(5);
        await scanner.scan(1n, inputs(2));
        expect(scanner.lastStats.scanned).toBe(2);

        failing = true;
        await expect(scanner.scan(1n, inputs(3))).rejects.toThrow(/scan failed/);
        expect(scanner.lastStats).toEqual(emptyScanStats());

        failing = false;
        await scanner.scan(1n, inputs(4));
        expect(scanner.lastStats.scanned).toBe(4);
        await scanner.scan(1n, []);
        expect(scanner.lastStats).toEqual(emptyScanStats());
        await scanner.dispose();
    });

    /**
     * The worker entrypoint itself, served in this thread. `entry.ts` installs its handlers on
     * the worker global when it is evaluated and answers through it, so the global is given a
     * port until `close`; `worker` is the other end of that port.
     */
    async function entryInThread(): Promise<{ worker: WorkerLike; close: () => void }> {
        let toEntry: ((ev: { data: unknown }) => void) | undefined;
        const worker = {
            onmessage: null as ((ev: { data: unknown }) => void) | null,
            onerror: null,
            onmessageerror: null,
            terminate: vi.fn(),
            postMessage: (data: unknown) => void toEntry?.({ data }),
        };
        vi.stubGlobal("postMessage", (data: unknown) => worker.onmessage?.({ data }));
        vi.stubGlobal("addEventListener", (type: string, cb: (ev: { data: unknown }) => void) => {
            if (type === "message") toEntry = cb;
        });
        const close = () => {
            vi.unstubAllGlobals();
            // The entrypoint forwards its log records to the port.
            configureLogging({ sink: null });
        };
        try {
            await import("./entry.js");
            expect(toEntry).toBeDefined();
        } catch (err) {
            close();
            throw err;
        }
        return { worker: worker as unknown as WorkerLike, close };
    }

    it("counts a note with a tampered clue as clueMismatch, through the worker entrypoint", async () => {
        const P = await Poseidon.build();
        const J = await Jubjub.build();
        const me = buildSpendingKey(P, 4242n);
        const eve = buildSpendingKey(P, 9999n);
        const feedRow = (owner: typeof me, leafIndex: number): ScanInput => {
            const sealed = sealOutput(J, P, {
                outgoingKey: new Uint8Array(32).fill(7),
                chainId: 31337n,
                rho: BigInt(1000 + leafIndex),
                asset: 1n,
                value: 500n,
                recipient: recipientAt(P, J, owner, leafIndex),
                nullifiers: [],
            });
            return sealedScanInput(P, J, sealed, { leafIndex, blockNumber: 9 });
        };
        const tampered = feedRow(me, 1);
        // Another output's clue point: a valid packed point, not this note's.
        tampered.clueR = feedRow(me, 5).clueR;
        const flippedBits = feedRow(me, 2);
        flippedBits.ciphertext[1]! ^= 1;

        const { worker, close } = await entryInThread();
        try {
            // Three chunks through the one worker.
            const scanner = new WorkerPoolScanner({ size: 1, chunkSize: 2, factory: () => worker });
            const hits = await scanner.scan(me.ivk, [
                feedRow(me, 0),
                tampered,
                flippedBits,
                feedRow(eve, 3),
                feedRow(me, 4),
            ]);

            expect(hits.map((h) => h.leafIndex)).toEqual([0, 4]);
            expect(scanner.lastStats).toEqual({
                ...emptyScanStats(),
                scanned: 5,
                notOurs: 1,
                clueMismatch: 2,
                hits: 2,
            });
            await scanner.dispose();
        } finally {
            close();
        }
    });
});
