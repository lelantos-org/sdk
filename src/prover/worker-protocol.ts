// Prover worker wire types — the payload shapes only. Transport is
// `src/worker/`; the client and the worker entry both depend on this module.

import type { ProveResult, ProverPaths } from "./types.js";

/**
 * Settings that must reach the worker's own module realm.
 *
 * The worker never sees the caller's module-level configuration, so anything
 * serializable that a caller can set on the main thread has to travel here
 * too. Both are honoured only on the FIRST request — the thread pool and the
 * prover session are built once and reused.
 */
export interface WorkerSetup {
    /** Pin rayon thread count. */
    threads?: number | undefined;
    /**
     * Set `false` to skip persisting downloaded artifacts in the worker.
     * A custom `ArtifactCache` cannot cross `postMessage`; install that with
     * `configureArtifactCache` inside the worker instead.
     */
    cacheArtifacts?: boolean | undefined;
}

export interface ProveParams extends WorkerSetup {
    paths: ProverPaths;
    input: Record<string, unknown>;
}

export interface PreloadParams extends WorkerSetup {
    paths: ProverPaths;
}

/** Method table for the prover worker. */
export type ProverMethods = {
    /** Warm the worker: build WasmProver, fetch artifacts, init rayon. */
    preload: { params: PreloadParams; result: undefined };
    prove: { params: ProveParams; result: ProveResult };
};
