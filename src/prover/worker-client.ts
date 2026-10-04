// Client-side `Prover` that posts work to a Web Worker running the
// `@lelantos-org/sdk/workers/prover` entrypoint.
//
// Correlation, timeouts and crash handling come from `src/runtime/rpc/`.

import { createWorkerRpc, type WorkerRpc } from "../runtime/rpc/client.js";
import type { WorkerFactory, WorkerLike } from "../runtime/rpc/types.js";
import { resolveArtifacts } from "./artifact-paths.js";
import type { ProveResult, Prover, ProverArtifacts, ProverPaths } from "./types.js";
import type { ProverMethods, WorkerSetup } from "./worker-protocol.js";

/**
 * Long deadlines: proving can take minutes and the artifact fetch is tens of MB. Neither call is
 * retried.
 */
const PRELOAD_TIMEOUT_MS = 180_000;
const PROVE_TIMEOUT_MS = 180_000;

export interface WorkerProverOpts extends WorkerSetup {
    /** Worker running `@lelantos-org/sdk/workers/prover`. */
    worker: WorkerLike;
    /** Circuit artifacts. The worker builds its prover from them once and caches it. */
    artifacts: ProverArtifacts;
}

export class WorkerProver implements Prover {
    private readonly rpc: WorkerRpc<ProverMethods>;
    private readonly paths: ProverPaths;
    private readonly setup: WorkerSetup;

    constructor(opts: WorkerProverOpts) {
        this.paths = resolveArtifacts(opts.artifacts);
        // Sent with every request; see `WorkerSetup`.
        this.setup = { threads: opts.threads, cacheArtifacts: opts.cacheArtifacts };
        this.rpc = createWorkerRpc<ProverMethods>(opts.worker, {
            name: "prover",
            timeouts: { preload: PRELOAD_TIMEOUT_MS, prove: PROVE_TIMEOUT_MS },
        });
    }

    prove(input: Record<string, unknown>): Promise<ProveResult> {
        return this.rpc.call("prove", { paths: this.paths, input, ...this.setup });
    }

    /**
     * Warm the worker (build `WasmProver`, fetch zkey + wasm, init rayon).
     * Call before the first proof to keep the setup latency out of a
     * transaction.
     */
    preload(): Promise<void> {
        return this.rpc.call("preload", { paths: this.paths, ...this.setup });
    }

    /** Tear down the worker; pending proofs reject. */
    dispose(): void {
        this.rpc.dispose("WorkerProver disposed");
    }
}

export interface BrowserWorkerProverOpts extends WorkerSetup {
    /** Spawns the worker. See {@link WorkerFactory}. */
    worker: WorkerFactory;
    artifacts: ProverArtifacts;
}

/** Spawns the Worker and returns a `WorkerProver`. */
export function browserWorkerProver({ worker, ...opts }: BrowserWorkerProverOpts): WorkerProver {
    return new WorkerProver({ worker: worker(), ...opts });
}
