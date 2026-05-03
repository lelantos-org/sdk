// Single entry point for configuring all wasm-pack modules consumed by the
// SDK. Apps wiring Vite/Webpack write one call instead of two:
//
//   import jubjubMod from "@lelantos-org/sdk/wasm/jubjub";
//   import jubjubBin from "@lelantos-org/sdk/wasm/jubjub/wasm?url";
//   import proverMod from "@lelantos-org/sdk/wasm/prover";
//   import proverBin from "@lelantos-org/sdk/wasm/prover/wasm?url";
//
//   configureWasm({
//       jubjub: { loadModule: () => Promise.resolve(jubjubMod), wasm: jubjubBin },
//       prover: { loadModule: () => Promise.resolve(proverMod), wasm: proverBin },
//   });
//
// Both per-crate `configureJubjubWasm` / `configureProverWasm` remain
// exported for callers that wire them individually.

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
