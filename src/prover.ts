// snarkjs Groth16 wrapper. Paths are placeholders — set them via
// `configureProver({ wasmPath, zkeyPath })` at app boot, or pass them
// per-call. Build artifacts live under `circuits/build/` after the
// trusted-setup ceremony output is materialised.

import * as snarkjs from "snarkjs";

export interface ProverPaths {
    wasmPath: string; // e.g. "circuits/build/2x2_js/2x2.wasm"
    zkeyPath: string; // e.g. "circuits/build/2x2_final.zkey"
}

let DEFAULT_PATHS: ProverPaths | null = null;

export function configureProver(paths: ProverPaths): void {
    DEFAULT_PATHS = paths;
}

export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: "groth16";
    curve: "bn128";
}

export interface ProveResult {
    proof: Groth16Proof;
    publicSignals: string[];
}

export async function prove(
    input: Record<string, unknown>,
    paths: ProverPaths | null = DEFAULT_PATHS,
): Promise<ProveResult> {
    if (!paths) throw new Error("prover paths not configured (call configureProver)");
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
        input,
        paths.wasmPath,
        paths.zkeyPath,
    );
    return { proof, publicSignals };
}

export async function verify(
    vkey: object,
    publicSignals: string[],
    proof: Groth16Proof,
): Promise<boolean> {
    return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

// Solidity calldata formatter for the on-chain Verifier.sol.
export async function exportSolidityCallData(
    proof: Groth16Proof,
    publicSignals: string[],
): Promise<string> {
    return snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
}
