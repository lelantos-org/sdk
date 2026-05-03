// Client-side `Prover` implementation that posts work to a Web Worker
// running `prover-worker.ts`. Lets browser apps run the rust Groth16
// prover off the main thread without dragging `wasm-bindgen-rayon`'s
// worker glue into the main bundle.
//
// Usage (Vite-style; webpack/Rspack/esbuild also recognise the pattern):
//
//   import { browserWorkerProver } from "@lelantos-org/sdk";
//
//   const prover = browserWorkerProver({
//       workerUrl: new URL("@lelantos-org/sdk/prover-worker", import.meta.url),
//       paths: proverArtifacts,
//   });
//   const wallet = await Wallet.connect({ ..., prover });

import type { ProveResult, ProverPaths } from "../prover.js";
import { resolveArtifacts } from "../prover.js";
import type { ProverArtifacts } from "../types.js";
import type { Prover } from "./prover.js";

/// Minimal Worker surface — accepts native browser `Worker` or any shim
/// (e.g. `node:worker_threads` adapter) that exposes the same shape.
export interface WorkerLike {
    postMessage(msg: unknown, transfer?: Transferable[]): void;
    terminate(): void;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onerror?: ((ev: unknown) => void) | null;
    addEventListener?(type: "message", cb: (ev: { data: unknown }) => void): void;
    addEventListener?(type: "error", cb: (ev: unknown) => void): void;
}

export interface WorkerProverOpts {
    /// Worker running `@lelantos-org/sdk/prover-worker`.
    worker: WorkerLike;
    /// Snarkjs / wasm-pack artifact URLs. Sent to the worker on first
    /// `prove()` call and cached there.
    paths: ProverPaths | ProverArtifacts;
    /// Pin the rayon thread count inside the worker. Defaults to
    /// `min(8, navigator.hardwareConcurrency)`. Pass `1` to force
    /// single-threaded for benchmarking; `>= 2` for parallel.
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

    /// Warm the worker: builds `WasmProver`, fetches zkey + circuit wasm,
    /// initialises the rayon thread pool. Call ahead of the first
    /// deposit/transfer so the user doesn't pay 5–10 s setup latency in
    /// the middle of a transaction.
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

    /// Tear down the worker. Pending proves reject.
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

        // Surface uncaught worker errors (script load failures, top-level
        // throws inside `wasm-prover` init) so they don't sit forever as
        // silent stuck `pending` entries.
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

export interface BrowserWorkerProverOpts {
    /// Worker module URL. Resolved by your bundler from the call site:
    ///   `workerUrl: new URL("@lelantos-org/sdk/prover-worker", import.meta.url)`
    workerUrl: string | URL;
    paths: ProverPaths | ProverArtifacts;
    /// See `WorkerProverOpts.threads`.
    threads?: number;
}

/// Convenience factory: spawns the Worker for you, returns a `WorkerProver`.
export function browserWorkerProver(opts: BrowserWorkerProverOpts): WorkerProver {
    const worker = new Worker(opts.workerUrl, { type: "module" }) as unknown as WorkerLike;
    return new WorkerProver({ worker, paths: opts.paths, threads: opts.threads });
}
