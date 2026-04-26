// Prover worker wire types — the payload shapes only. Transport is
// `src/worker/`; the client and the worker entry both depend on this module.

import type { ProveResult, ProverPaths } from "./types.js";

export interface ProveParams {
    paths: ProverPaths;
    input: Record<string, unknown>;
    /**
     * Pin rayon thread count. Only honoured on the FIRST request; the pool
     * is reused across subsequent ones.
     */
    threads?: number;
}

export interface PreloadParams {
    paths: ProverPaths;
    threads?: number;
}

/** Method table for the prover worker. */
export type ProverMethods = {
    /** Warm the worker: build WasmProver, fetch artifacts, init rayon. */
    preload: { params: PreloadParams; result: undefined };
    prove: { params: ProveParams; result: ProveResult };
};
