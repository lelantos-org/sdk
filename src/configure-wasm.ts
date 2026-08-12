// Single entry point for configuring all wasm-pack modules consumed by the SDK.
// Example:
//   configureWasm({
//       jubjub: { loadModule: () => Promise.resolve(jubjubMod), wasm: jubjubBin },
//       prover: { loadModule: () => Promise.resolve(proverMod), wasm: proverBin },
//   });
// Per-crate alternatives: `configureJubjubWasm`, `configureProverWasm`.

import { configureJubjubWasm, type JubjubWasmLoader } from "./crypto/jubjub-wasm/index.js";
import { configureProverWasm, type ProverWasmLoader } from "./prover/wasm-loader.js";

/** @internal */
export interface WasmConfig {
    jubjub?: JubjubWasmLoader;
    prover?: ProverWasmLoader;
}

/** @internal */
export function configureWasm(cfg: WasmConfig): void {
    if (cfg.jubjub) configureJubjubWasm(cfg.jubjub);
    if (cfg.prover) configureProverWasm(cfg.prover);
}
