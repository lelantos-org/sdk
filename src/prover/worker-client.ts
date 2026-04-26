// Client-side `Prover` that posts work to a Web Worker running `prover-worker.ts`.

import type { ProverArtifacts } from "./artifacts.js";
import type { Prover } from "./interface.js";
import type { ProveResult, ProverPaths } from "./snarkjs.js";
import { resolveArtifacts } from "./snarkjs.js";

/** @internal */
/// Minimal Worker surface — accepts native `Worker` or any compatible shim.
export interface WorkerLike {
    postMessage(msg: unknown, transfer?: Transferable[]): void;
    terminate(): void;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror?: ((ev: unknown) => void) | null;
    addEventListener?(type: "message", cb: (ev: { data: unknown }) => void): void;
    addEventListener?(type: "error", cb: (ev: unknown) => void): void;
}

/** @internal */
export interface WorkerProverOpts {
    /// Worker running `@lelantos-org/sdk/prover-worker`.
    worker: WorkerLike;
    /// Artifact URLs. Sent to the worker on first `prove()` and cached.
    paths: ProverPaths | ProverArtifacts;
    /// Pin rayon thread count. Default: `min(8, navigator.hardwareConcurrency)`.
    threads?: number;
}

interface PendingEntry {
    resolve: (r: ProveResult) => void;
    reject: (e: Error) => void;
}

export class WorkerProver implements Prover {
    private readonly worker: WorkerLike;
    private readonly paths: ProverPaths;
    private readonly threads?: number;
    private readonly pending = new Map<number, PendingEntry>();
    private nextId = 1;

    constructor(opts: WorkerProverOpts) {
        this.worker = opts.worker;
        this.paths = resolveArtifacts(opts.paths);
        this.threads = opts.threads;
        this.attachListeners();
    }

    prove(input: Record<string, unknown>): Promise<ProveResult> {
        const id = this.nextId++;
        return new Promise<ProveResult>((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({
                type: "prove",
                id,
                paths: this.paths,
                input,
                threads: this.threads,
            });
        });
    }

    /// Warm the worker (build `WasmProver`, fetch zkey + wasm, init rayon).
    /// Call ahead of first deposit/transfer to avoid 5–10s setup latency mid-tx.
    preload(): Promise<void> {
        const id = this.nextId++;
        return new Promise<void>((resolve, reject) => {
            this.pending.set(id, {
                resolve: (() => resolve()) as unknown as (r: ProveResult) => void,
                reject,
            });
            this.worker.postMessage({
                type: "preload",
                id,
                paths: this.paths,
                threads: this.threads,
            });
        });
    }

    /// Tear down the worker; pending proves reject.
    dispose(): void {
        for (const [, p] of this.pending) p.reject(new Error("WorkerProver disposed"));
        this.pending.clear();
        this.worker.terminate();
    }

    private attachListeners(): void {
        const onMessage = (ev: { data: unknown }): void => {
            const msg = ev.data as
                | { type: "prove-res"; id: number; result: ProveResult }
                | { type: "preload-res"; id: number }
                | { type: "error"; id: number; message: string }
                | undefined;
            if (!msg) return;
            const p = this.pending.get(msg.id);
            if (!p) return;
            this.pending.delete(msg.id);
            if (msg.type === "prove-res") p.resolve(msg.result);
            else if (msg.type === "preload-res") p.resolve(undefined as unknown as ProveResult);
            else p.reject(new Error(msg.message));
        };
        if (this.worker.addEventListener) {
            this.worker.addEventListener("message", onMessage);
        } else {
            this.worker.onmessage = onMessage;
        }

        // Surface uncaught worker errors so pending entries don't hang silently.
        const onError = (ev: unknown): void => {
            const e = ev as { message?: string; filename?: string; lineno?: number };
            const msg =
                `[WorkerProver] worker error: ${e?.message ?? "unknown"}` +
                (e?.filename ? ` at ${e.filename}:${e.lineno ?? "?"}` : "");
            // eslint-disable-next-line no-console
            console.error(msg, ev);
            for (const [, p] of this.pending) p.reject(new Error(msg));
            this.pending.clear();
        };
        if (this.worker.addEventListener) {
            this.worker.addEventListener("error", onError);
        } else {
            this.worker.onerror = onError;
        }
    }
}

/** @internal */
export interface BrowserWorkerProverOpts {
    /// `new URL("@lelantos-org/sdk/prover-worker", import.meta.url)`
    workerUrl: string | URL;
    paths: ProverPaths | ProverArtifacts;
    threads?: number;
}

/// Spawns the Worker and returns a `WorkerProver`.
export function browserWorkerProver(opts: BrowserWorkerProverOpts): WorkerProver {
    const worker = new Worker(opts.workerUrl, { type: "module" }) as unknown as WorkerLike;
    return new WorkerProver({ worker, paths: opts.paths, threads: opts.threads });
}
