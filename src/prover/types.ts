// The prover port and its data shapes.
//
// Imports only `core/`, so referencing a prover type never pulls in `snarkjs`
// (an optional peer dependency). Code that needs only the shapes imports this
// module rather than a backend.

import type { Url } from "../core/url.js";

/** Expected SHA-256 of an artifact pair, lowercase hex without `0x`. */
export interface ArtifactDigests {
    /** Digest of `<shape>.wasm`. */
    circuit: string;
    /** Digest of `<shape>_final.zkey`. */
    zkey: string;
}

/** Snarkjs Groth16 artifacts: WASM witness calculator + final zkey. */
export interface ProverArtifacts {
    /** `<circuit>.wasm` — circom-generated witness calculator. */
    circuit: Url;
    /** `<circuit>_final.zkey` — phase-2 contribution output. */
    zkey: Url;
    /**
     * Expected SHA-256 of each file. When set, bytes that hash to anything else
     * are refused (`PROVER_ARTIFACTS_FAILED`) before they are parsed, whether
     * they came from the network, disk or a cache. `PROVER_ARTIFACT_SHA256`
     * holds the digests of the published release.
     */
    sha256?: ArtifactDigests | undefined;
}

/**
 * {@link ProverArtifacts} resolved to absolute filesystem/URL strings, as they
 * cross `postMessage` to a worker.
 *
 * @internal
 */
export interface ProverPaths {
    wasmPath: string; // `<shape>.wasm`
    zkeyPath: string; // `<shape>_final.zkey`
    /** Expected digests, when the artifacts are pinned. */
    sha256?: ArtifactDigests | undefined;
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
     * Optional: a backend with nothing to release omits it. `WorkerProver`
     * owns a worker and requires this call.
     */
    dispose?(): Promise<void> | void;
}
