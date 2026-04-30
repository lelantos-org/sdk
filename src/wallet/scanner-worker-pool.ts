// WorkerPoolScanner — fans `scanNotes` across N Web Workers.
//
// Decoupled from any specific Worker constructor: caller injects a
// `WorkerFactory`. App glue (Vite/webpack) wires the worker URL:
//
//   new WorkerPoolScanner({
//       factory: () => new Worker(
//           new URL("@lelantos/sdk/scanner-worker", import.meta.url),
//           { type: "module" },
//       ),
//   });

import type { Field } from "../crypto/index";
import type { ScanInput, ScanHit } from "../sync";
import type { FmdDetectionKey } from "../fmd";
import type { Scanner } from "./scanner";
import {
    encodeInput,
    encodeDetection,
    decodeHit,
    transferablesOf,
    type InitReq,
    type InitRes,
    type ScanReq,
    type ScanRes,
    type ScanErr,
} from "./scanner-worker-protocol";

export interface WorkerLike {
    postMessage(msg: unknown, transfer?: Transferable[]): void;
    terminate(): void;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror?: ((ev: unknown) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

export interface WorkerPoolScannerOpts {
    factory: WorkerFactory;
    /// Pool size. Defaults to clamp(navigator.hardwareConcurrency, 2, 8).
    size?: number;
    /// Notes per chunk. Defaults to ceil(inputs.length / size).
    chunkSize?: number;
}

export class WorkerPoolScanner implements Scanner {
    private readonly workers: WorkerLike[];
    private readonly chunkSize?: number;
    private readonly initPromise: Promise<void>;
    private nextReqId = 1;

    constructor(opts: WorkerPoolScannerOpts) {
        const size = opts.size ?? defaultPoolSize();
        if (size < 1) throw new Error("WorkerPoolScanner: size must be >= 1");
        this.workers = Array.from({ length: size }, () => opts.factory());
        this.chunkSize = opts.chunkSize;
        this.initPromise = Promise.all(
            this.workers.map((w) => this.initOne(w)),
        ).then(() => undefined);
    }

    private initOne(worker: WorkerLike): Promise<void> {
        const id = this.nextReqId++;
        const req: InitReq = { type: "init", id };
        return new Promise<void>((resolve, reject) => {
            const prev = worker.onmessage;
            worker.onmessage = (ev: { data: unknown }): void => {
                const msg = ev.data as InitRes | ScanErr;
                if (!msg || (msg as { id?: number }).id !== id) return;
                worker.onmessage = prev;
                if (msg.type === "init-res") resolve();
                else reject(new Error((msg as ScanErr).message ?? "worker init failed"));
            };
            worker.postMessage(req);
        });
    }

    async scan(
        ivk: Field,
        inputs: ScanInput[],
        detectionKey?: FmdDetectionKey,
    ): Promise<ScanHit[]> {
        if (inputs.length === 0) return [];
        await this.initPromise;

        const n = this.workers.length;
        const chunkSize = this.chunkSize ?? Math.max(1, Math.ceil(inputs.length / n));
        const chunks: ScanInput[][] = [];
        for (let i = 0; i < inputs.length; i += chunkSize) {
            chunks.push(inputs.slice(i, i + chunkSize));
        }

        const dkWire = encodeDetection(detectionKey);
        const ivkStr = ivk.toString();

        const tasks = chunks.map((chunk, idx) =>
            this.runOne(this.workers[idx % n], ivkStr, chunk, dkWire),
        );
        const partials = await Promise.all(tasks);

        const out: ScanHit[] = [];
        for (const p of partials) for (const h of p) out.push(h);
        out.sort((a, b) => a.leafIndex - b.leafIndex);
        return out;
    }

    async dispose(): Promise<void> {
        for (const w of this.workers) {
            w.onmessage = null;
            w.terminate();
        }
    }

    private runOne(
        worker: WorkerLike,
        ivk: string,
        chunk: ScanInput[],
        detectionKey: ReturnType<typeof encodeDetection>,
    ): Promise<ScanHit[]> {
        const id = this.nextReqId++;
        const wireInputs = chunk.map(encodeInput);
        const transfer = transferablesOf(wireInputs);
        const req: ScanReq = { type: "scan", id, ivk, inputs: wireInputs, detectionKey };

        return new Promise<ScanHit[]>((resolve, reject) => {
            const prev = worker.onmessage;
            worker.onmessage = (ev: { data: unknown }): void => {
                const msg = ev.data as ScanRes | ScanErr;
                if (!msg || (msg as { id?: number }).id !== id) return;
                worker.onmessage = prev;
                if (msg.type === "scan-res") resolve(msg.hits.map(decodeHit));
                else reject(new Error(msg.message));
            };
            worker.postMessage(req, transfer);
        });
    }
}

function defaultPoolSize(): number {
    const hw = (globalThis as { navigator?: { hardwareConcurrency?: number } })
        .navigator?.hardwareConcurrency ?? 4;
    return Math.max(2, Math.min(8, hw));
}
