// Pluggable Groth16 prover. Default uses snarkjs locally; apps can swap
// in a remote prover (HTTP RPC), a Worker-based prover (off-main-thread),
// or a mock.

import { type ProveResult, type ProverPaths, prove } from "../prover.js";

export interface Prover {
    /// Prove a witness against the configured circuit.
    /// Input shape is the `Record<string, unknown>` snarkjs accepts.
    prove(input: Record<string, unknown>): Promise<ProveResult>;
}

/// Default — runs snarkjs Groth16 in-process against local wasm + zkey files.
export class SnarkjsProver implements Prover {
    constructor(private readonly paths: ProverPaths) {}

    prove(input: Record<string, unknown>): Promise<ProveResult> {
        return prove(input, this.paths);
    }
}
