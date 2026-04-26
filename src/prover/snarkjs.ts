// snarkjs Groth16 backend. The only module in the SDK that touches
// `snarkjs`, which is an optional peer dependency — everything else depends
// on `./types.js`.

import type * as SnarkjsT from "snarkjs";
import { ProverError } from "../core/errors.js";
import { loadArtifactBytes } from "./artifacts.js";
import type { Groth16Proof, ProveResult, Prover, ProverPaths } from "./types.js";

let snarkjsMod: typeof SnarkjsT | null = null;

async function loadSnarkjs(): Promise<typeof SnarkjsT> {
    if (snarkjsMod) return snarkjsMod;
    try {
        snarkjsMod = (await import("snarkjs")) as typeof SnarkjsT;
        return snarkjsMod;
    } catch (e) {
        throw new ProverError(
            "snarkjs prover requested but `snarkjs` is not installed. " +
                "Add it to your app dependencies (`npm i snarkjs`), or use the WASM prover " +
                "(`@lelantos-org/sdk/wasm-prover`).",
            { cause: e },
        );
    }
}

/** @internal */
export async function prove(
    input: Record<string, unknown>,
    paths: ProverPaths,
): Promise<ProveResult> {
    const snarkjs = await loadSnarkjs();
    // Bytes are cached across proofs; snarkjs (via fastfile) treats a
    // Uint8Array as an in-memory file, skipping the per-proof fs read /
    // network fetch of the ~36 MB zkey.
    const [wasmBytes, zkeyBytes] = await Promise.all([
        loadArtifactBytes(paths.wasmPath),
        loadArtifactBytes(paths.zkeyPath),
    ]);
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasmBytes, zkeyBytes);
    return { proof, publicSignals };
}

/** @internal */
export async function verify(
    vkey: object,
    publicSignals: string[],
    proof: Groth16Proof,
): Promise<boolean> {
    const snarkjs = await loadSnarkjs();
    return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

/**
 * Runs snarkjs Groth16 in-process against local wasm + zkey files.
 *
 * @internal
 */
export class SnarkjsProver implements Prover {
    constructor(private readonly paths: ProverPaths) {}

    prove(input: Record<string, unknown>): Promise<ProveResult> {
        return prove(input, this.paths);
    }
}
