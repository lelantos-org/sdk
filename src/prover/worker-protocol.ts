// Prover worker payload types. Transport lives in `src/runtime/rpc/`; the client and
// the worker entry both depend on this module.

import type { ProveResult, ProverPaths } from "./types.js";

/**
 * Settings that must reach the worker's own module realm.
 *
 * The worker cannot see the caller's module-level configuration, so
 * serializable main-thread settings are sent here. Both are honoured only on
 * the first request, since the thread pool and prover session are built once.
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

interface ProveParams extends WorkerSetup {
    paths: ProverPaths;
    input: Record<string, unknown>;
}

interface PreloadParams extends WorkerSetup {
    paths: ProverPaths;
}

/** Method table for the prover worker. */
export type ProverMethods = {
    /** Warm the worker: build WasmProver, fetch artifacts, init rayon. */
    preload: { params: PreloadParams; result: undefined };
    prove: { params: ProveParams; result: ProveResult };
};
