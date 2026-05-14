// Single entry point for configuring all wasm-pack modules consumed by the SDK.
// Example:
//   configureWasm({
//       jubjub: { loadModule: () => Promise.resolve(jubjubMod), wasm: jubjubBin },
//       prover: { loadModule: () => Promise.resolve(proverMod), wasm: proverBin },
//   });
// Per-crate `configureJubjubWasm` / `configureProverWasm` remain exported.

import { configureJubjubWasm, type JubjubWasmLoader } from "../crypto/jubjub-wasm.js";
import { configureProverWasm, type ProverWasmLoader } from "../wallet/wasm-prover.js";

export interface WasmConfig {
    jubjub?: JubjubWasmLoader;
    prover?: ProverWasmLoader;
}

export function configureWasm(cfg: WasmConfig): void {
    if (cfg.jubjub) configureJubjubWasm(cfg.jubjub);
    if (cfg.prover) configureProverWasm(cfg.prover);
}
