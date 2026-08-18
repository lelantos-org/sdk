// Pool of scanner workers, one RPC client per worker.
//
// Correlation, timeouts and crash handling all come from `src/worker/`, so
// concurrent `runOne` calls on one worker stay correlated and a dead worker
// rejects its in-flight calls rather than leaving them pending.

import { InternalError } from "../../core/errors.js";
import type { Field } from "../../crypto/index.js";
import { getLogger } from "../../log/logger.js";
import { createWorkerRpc, type WorkerRpc } from "../../worker/client.js";
import { spawnModuleWorker } from "../../worker/spawn.js";
import type { WorkerLike } from "../../worker/types.js";
import type { ScanHit, ScanInput } from "../scan.js";
import type { Scanner } from "../scanner.js";
import {
    decodeHit,
    encodeInput,
    type ScannerMethods,
    transferablesOf,
    type WireWasmConfig,
} from "./protocol.js";

const log = getLogger("lelantos:sync:pool");

/** Wasm init can involve a network fetch; scanning is CPU-bound per chunk. */
const INIT_TIMEOUT_MS = 30_000;
const SCAN_TIMEOUT_MS = 60_000;

export type WorkerFactory = () => WorkerLike;

export interface WorkerPoolScannerOpts {
    factory: WorkerFactory;
    size?: number | undefined;
    chunkSize?: number | undefined;
    /** Forwarded to each worker on `init`. See {@link WireWasmConfig}. */
    wasm?: WireWasmConfig | undefined;
}

interface Slot {
    rpc: WorkerRpc<ScannerMethods>;
    ready: Promise<void>;
}

export class WorkerPoolScanner implements Scanner {
    private readonly factory: WorkerFactory;
    private readonly chunkSize?: number | undefined;
    private readonly wasm?: WireWasmConfig | undefined;
    private slots: Slot[];

    constructor(opts: WorkerPoolScannerOpts) {
        const size = opts.size ?? defaultPoolSize();
        if (size < 1) throw new RangeError("WorkerPoolScanner: size must be >= 1");
        this.factory = opts.factory;
        this.chunkSize = opts.chunkSize;
        this.wasm = opts.wasm;
        this.slots = Array.from({ length: size }, (_, i) => this.spawn(i));
    }

    private spawn(index: number): Slot {
        const rpc = createWorkerRpc<ScannerMethods>(this.factory(), {
            name: `scanner#${index}`,
            timeouts: { init: INIT_TIMEOUT_MS, scan: SCAN_TIMEOUT_MS },
        });
        const ready = rpc.call("init", this.wasm ? { wasm: this.wasm } : {});
        // `ready` is only awaited inside `runChunk`, so a pool that is
        // disposed — or whose owner never scans — would leave this rejection
        // unobserved and trip Node's `unhandledRejection`. Marking it handled
        // here does not swallow it: `runChunk` still awaits the same promise
        // and still sees the failure.
        ready.catch(() => {});
        return { rpc, ready };
    }

    /**
     * Replace a dead worker. The scan that killed it is not retried: its input
     * buffers were transferred and are now detached, so a resend would scan
     * empty ciphertexts and report no hits.
     */
    private recycle(index: number): void {
        log.warn("recycling scanner worker", { index });
        this.slots[index]?.rpc.dispose("recycled after failure");
        this.slots[index] = this.spawn(index);
    }

    async scan(ivk: Field, inputs: ScanInput[]): Promise<ScanHit[]> {
        if (inputs.length === 0) return [];

        const n = this.slots.length;
        const chunkSize = this.chunkSize ?? Math.max(1, Math.ceil(inputs.length / n));
        const chunks: ScanInput[][] = [];
        for (let i = 0; i < inputs.length; i += chunkSize) {
            chunks.push(inputs.slice(i, i + chunkSize));
        }

        const ivkStr = ivk.toString();
        log.debug("scanning", { notes: inputs.length, chunks: chunks.length, workers: n });

        // One in-flight scan per slot, pulling from a shared queue, rather
        // than dispatching every chunk at once.
        //
        // A worker handles its messages serially, so dispatching N chunks to
        // one slot did not make it faster — it made all N share a single
        // `SCAN_TIMEOUT_MS` while queued behind each other. A large sync with
        // a small `chunkSize` therefore timed out chunks that had done no work
        // yet, and `recycle` then discarded a perfectly healthy worker.
        //
        // Pulling also load-balances: a slot that finishes early takes the
        // next chunk instead of idling while a slower one works through a
        // fixed share.
        const partials: ScanHit[][] = new Array(chunks.length);
        let nextChunk = 0;
        const runner = async (slotIndex: number): Promise<void> => {
            for (;;) {
                const idx = nextChunk++;
                const chunk = chunks[idx];
                if (!chunk) return;
                partials[idx] = await this.runChunk(slotIndex, ivkStr, chunk, idx);
            }
        };
        await Promise.all(Array.from({ length: n }, (_, i) => runner(i)));

        const out: ScanHit[] = [];
        for (const p of partials) for (const h of p) out.push(h);
        out.sort((a, b) => a.leafIndex - b.leafIndex);
        return out;
    }

    private async runChunk(
        slotIndex: number,
        ivk: string,
        chunk: ScanInput[],
        chunkIndex: number,
    ): Promise<ScanHit[]> {
        const slot = this.slots[slotIndex];
        if (!slot) throw new InternalError(`scanner pool has no slot ${slotIndex}`);
        const wireInputs = chunk.map(encodeInput);
        const transfer = transferablesOf(wireInputs);

        try {
            await slot.ready;
            const { hits } = await slot.rpc.call(
                "scan",
                { ivk, inputs: wireInputs },
                {
                    transfer,
                    // Carried into any thrown error: which leaves failed is
                    // the first thing a scan diagnosis needs.
                    context: {
                        chunk: chunkIndex,
                        leafFrom: chunk[0]?.leafIndex,
                        leafTo: chunk[chunk.length - 1]?.leafIndex,
                        notes: chunk.length,
                    },
                },
            );
            return hits.map(decodeHit);
        } catch (err) {
            if (!slot.rpc.alive) this.recycle(slotIndex);
            throw err;
        }
    }

    async dispose(): Promise<void> {
        for (const s of this.slots) s.rpc.dispose("pool disposed");
        this.slots = [];
    }
}

function defaultPoolSize(): number {
    const hw =
        (globalThis as { navigator?: { hardwareConcurrency?: number | undefined } }).navigator
            ?.hardwareConcurrency ?? 4;
    return Math.max(2, Math.min(8, hw));
}

export interface BrowserWorkerScannerOpts extends Omit<WorkerPoolScannerOpts, "factory"> {
    /** `new URL("@lelantos-org/sdk/scanner-worker", import.meta.url)` */
    workerUrl: string | URL;
}

export function browserWorkerScanner(opts: BrowserWorkerScannerOpts): WorkerPoolScanner {
    return new WorkerPoolScanner({
        factory: () => spawnModuleWorker(opts.workerUrl),
        size: opts.size,
        chunkSize: opts.chunkSize,
        wasm: opts.wasm,
    });
}
