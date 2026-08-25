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
    // network fetch of the ~29 MB zkey.
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

    /**
     * Terminate the curve worker pool snarkjs leaves running.
     *
     * `groth16.fullProve` installs `globalThis.curve_bn128` and its worker
     * threads, and nothing tears them down — so a Node CLI that proves once
     * then finishes hangs at exit instead of returning to the shell.
     * Idempotent, and safe when nothing was ever proved. Unlike
     * `WasmProver.shutdown` this is not a one-way door: snarkjs rebuilds the
     * curve on the next proof.
     */
    async dispose(): Promise<void> {
        await disposeCurve();
    }
}

/** Tear down snarkjs's global bn128 curve, if one was built. */
async function disposeCurve(): Promise<void> {
    const g = globalThis as {
        curve_bn128?: { terminate?: () => Promise<void> | void } | undefined;
    };
    const curve = g.curve_bn128;
    if (!curve?.terminate) return;
    try {
        await curve.terminate();
    } catch {
        // Already gone, or a snarkjs build without a terminable pool.
    }
    g.curve_bn128 = undefined;
}
