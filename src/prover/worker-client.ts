// Client-side `Prover` that posts work to a Web Worker running the
// `@lelantos-org/sdk/prover-worker` entrypoint.
//
// Correlation, timeouts and crash handling come from `src/worker/`, shared
// with the scanner pool.

import { createWorkerRpc, type WorkerRpc } from "../worker/client.js";
import { spawnModuleWorker } from "../worker/spawn.js";
import type { WorkerLike } from "../worker/types.js";
import { resolveArtifacts } from "./artifacts.js";
import type { ProveResult, Prover, ProverArtifacts, ProverPaths } from "./types.js";
import type { ProverMethods } from "./worker-protocol.js";

/**
 * Proving is minutes-long by design and artifact fetch is ~36 MB, so these
 * are generous. Neither is retried: a retried three-minute prove is a
 * six-minute frozen UI.
 */
const PRELOAD_TIMEOUT_MS = 180_000;
const PROVE_TIMEOUT_MS = 180_000;

export type { WorkerLike };

export interface WorkerProverOpts {
    /** Worker running `@lelantos-org/sdk/prover-worker`. */
    worker: WorkerLike;
    /** Artifact URLs. Sent to the worker on first `prove()` and cached there. */
    paths: ProverPaths | ProverArtifacts;
    /** Pin rayon thread count. Default: `max(2, navigator.hardwareConcurrency)`. */
    threads?: number;
}

export class WorkerProver implements Prover {
    private readonly rpc: WorkerRpc<ProverMethods>;
    private readonly paths: ProverPaths;
    private readonly threads?: number;

    constructor(opts: WorkerProverOpts) {
        this.paths = resolveArtifacts(opts.paths);
        this.threads = opts.threads;
        this.rpc = createWorkerRpc<ProverMethods>(opts.worker, {
            name: "prover",
            timeouts: { preload: PRELOAD_TIMEOUT_MS, prove: PROVE_TIMEOUT_MS },
        });
    }

    prove(input: Record<string, unknown>): Promise<ProveResult> {
        return this.rpc.call("prove", { paths: this.paths, input, threads: this.threads });
    }

    /**
     * Warm the worker (build `WasmProver`, fetch zkey + wasm, init rayon).
     * Call ahead of the first deposit/transfer to avoid 5–10s of setup
     * latency mid-transaction.
     */
    preload(): Promise<void> {
        return this.rpc.call("preload", { paths: this.paths, threads: this.threads });
    }

    /** Tear down the worker; pending proofs reject. */
    dispose(): void {
        this.rpc.dispose("WorkerProver disposed");
    }
}

export interface BrowserWorkerProverOpts {
    /** `new URL("@lelantos-org/sdk/prover-worker", import.meta.url)` */
    workerUrl: string | URL;
    paths: ProverPaths | ProverArtifacts;
    threads?: number;
}

/** Spawns the Worker and returns a `WorkerProver`. */
export function browserWorkerProver(opts: BrowserWorkerProverOpts): WorkerProver {
    return new WorkerProver({
        worker: spawnModuleWorker(opts.workerUrl),
        paths: opts.paths,
        threads: opts.threads,
    });
}
