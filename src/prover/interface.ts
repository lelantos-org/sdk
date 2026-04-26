// Pluggable Groth16 prover.

import { type ProveResult, type ProverPaths, prove } from "./snarkjs.js";

/** @internal */
export interface Prover {
    /// Prove a witness against the configured circuit.
    prove(input: Record<string, unknown>): Promise<ProveResult>;
}

/** @internal */
/// Runs snarkjs Groth16 in-process against local wasm + zkey files.
export class SnarkjsProver implements Prover {
    constructor(private readonly paths: ProverPaths) {}

    prove(input: Record<string, unknown>): Promise<ProveResult> {
        return prove(input, this.paths);
    }
}
