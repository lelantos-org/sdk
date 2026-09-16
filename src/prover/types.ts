// The prover port and its data shapes.
//
// Imports only `core/`, so referencing a prover type never pulls in `snarkjs`
// (an optional peer dependency). Code that needs only the shapes imports this
// module rather than a backend.

import type { Url } from "../core/url.js";

/** Snarkjs Groth16 artifacts: WASM witness calculator + final zkey. */
export interface ProverArtifacts {
    /** `<circuit>.wasm` — circom-generated witness calculator. */
    circuit: Url;
    /** `<circuit>_final.zkey` — phase-2 contribution output. */
    zkey: Url;
}

/**
 * {@link ProverArtifacts} resolved to absolute filesystem/URL strings, as they
 * cross `postMessage` to a worker.
 *
 * @internal
 */
export interface ProverPaths {
    wasmPath: string; // e.g. "circuits/build/4x6.wasm"
    zkeyPath: string; // e.g. "circuits/build/4x6_final.zkey"
}

/** @internal */
export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: "groth16";
    curve: "bn128";
}

/** @internal */
export interface ProveResult {
    proof: Groth16Proof;
    publicSignals: string[];
}

/** Pluggable Groth16 prover. */
export interface Prover {
    /** Prove a witness against the configured circuit. */
    prove(input: Record<string, unknown>): Promise<ProveResult>;
    /**
     * Release held resources (worker threads, wasm heaps).
     *
     * Optional: in-process backends hold nothing the GC does not reclaim.
     * `WorkerProver` owns a worker and requires this call.
     */
    dispose?(): Promise<void> | void;
}
