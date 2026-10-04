// snarkjs Groth16 backend. The only SDK module that imports `snarkjs` (an optional peer
// dependency), and only lazily: an eager import would make the peer mandatory.

import type * as SnarkjsT from "snarkjs";
import { memoAsync } from "../core/async.js";
import { ProverUnavailableError } from "../errors/prover.js";
import { loadArtifactBytes } from "./artifact-bytes.js";
import { resolveArtifacts } from "./artifact-paths.js";
import type { Groth16Proof, ProveResult, Prover, ProverArtifacts, ProverPaths } from "./types.js";

const snarkjsModule = memoAsync(() =>
    (import("snarkjs") as Promise<typeof SnarkjsT>).catch((e) => {
        throw new ProverUnavailableError(
            "snarkjs prover requested but `snarkjs` is not installed. " +
                "Add it to your app dependencies (`npm i snarkjs`), or use the WASM prover " +
                "(`WasmProver` from `@lelantos-org/sdk/prover`).",
            { cause: e },
        );
    }),
);

/** @internal */
export async function prove(
    input: Record<string, unknown>,
    paths: ProverPaths,
): Promise<ProveResult> {
    const snarkjs = await snarkjsModule.get();
    // Bytes are memoised across proofs; snarkjs (via fastfile) treats a
    // Uint8Array as an in-memory file, so the zkey is not re-read per proof.
    const [wasmBytes, zkeyBytes] = await Promise.all([
        loadArtifactBytes(paths.wasmPath, { sha256: paths.sha256?.circuit }),
        loadArtifactBytes(paths.zkeyPath, { sha256: paths.sha256?.zkey }),
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
    const snarkjs = await snarkjsModule.get();
    return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

/**
 * Runs snarkjs Groth16 in-process over the wasm + zkey artifacts.
 *
 * @internal
 */
export class SnarkjsProver implements Prover {
    private readonly paths: ProverPaths;

    constructor(artifacts: ProverArtifacts) {
        this.paths = resolveArtifacts(artifacts);
    }

    prove(input: Record<string, unknown>): Promise<ProveResult> {
        return prove(input, this.paths);
    }

    /**
     * Terminate the curve worker pool snarkjs leaves running.
     *
     * `groth16.fullProve` installs `globalThis.curve_bn128` and its worker
     * threads without tearing them down, which keeps a Node process from
     * exiting. Idempotent and safe when nothing was proved. Reversible, unlike
     * `WasmProver.shutdown`: snarkjs rebuilds the curve on the next proof.
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
