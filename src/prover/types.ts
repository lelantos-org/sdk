// The prover port and its data shapes.
//
// This module imports nothing but `core/`, so naming a prover type never
// pulls in `snarkjs` — an optional peer dependency. Anything that needs only
// the shapes (wasm backend, worker client, wallet config, bundle builder)
// imports this rather than a backend.

import type { Url } from "../core/url.js";

/** Snarkjs Groth16 artifacts: WASM witness calculator + final zkey. */
export interface ProverArtifacts {
    /** `<circuit>.wasm` — circom-generated witness calculator. */
    circuit: Url;
    /** `<circuit>_final.zkey` — phase-2 contribution output. */
    zkey: Url;
}

/** Resolved filesystem/URL strings for the two artifacts. */
export interface ProverPaths {
    wasmPath: string; // e.g. "circuits/build/2x2_js/2x2.wasm"
    zkeyPath: string; // e.g. "circuits/build/2x2_final.zkey"
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
}
