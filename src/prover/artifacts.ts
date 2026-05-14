// Prover artifact descriptor. Either filesystem path (Node) or fetchable
// URL (browser); SDK auto-detects.

import type { Url } from "../utils/types.js";

/// Snarkjs Groth16 artifacts: WASM witness calculator + final zkey.
export interface ProverArtifacts {
    /// `<circuit>.wasm` — circom-generated witness calculator.
    circuit: Url;
    /// `<circuit>_final.zkey` — phase-2 contribution output.
    zkey: Url;
}
