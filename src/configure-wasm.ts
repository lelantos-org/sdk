// Single entry point for configuring all wasm-pack modules consumed by the SDK.
// Example:
//   configureWasm({
//       jubjub: { loadModule: () => Promise.resolve(jubjubMod), wasm: jubjubBin },
//       prover: { loadModule: () => Promise.resolve(proverMod), wasm: proverBin },
//   });
// Per-crate alternatives: `configureJubjubWasm`, `configurePoseidonWasm`,
// `configureProverWasm`.
//
// Not required with bundlers that follow the `#wasm/*` subpath imports. Intended for bundlers that
// rewrite the wasm-pack glue's `new URL(..., import.meta.url)` to a path that does not exist at
// runtime.

import { configureJubjubWasm, type JubjubWasmLoader } from "./crypto/jubjub-wasm/loader.js";
import { configurePoseidonWasm, type PoseidonWasmLoader } from "./crypto/poseidon-wasm/loader.js";
import { configureProverWasm, type ProverWasmLoader } from "./runtime/wasm/prover-loader.js";

export interface WasmConfig {
    jubjub?: JubjubWasmLoader;
    poseidon?: PoseidonWasmLoader;
    prover?: ProverWasmLoader;
}

export function configureWasm(cfg: WasmConfig): void {
    if (cfg.jubjub) configureJubjubWasm(cfg.jubjub);
    if (cfg.poseidon) configurePoseidonWasm(cfg.poseidon);
    if (cfg.prover) configureProverWasm(cfg.prover);
}
