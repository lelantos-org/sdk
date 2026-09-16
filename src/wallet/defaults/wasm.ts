// `configureWasm`, with the prover loader (and its rayon worker glue) imported only when a prover
// module is actually configured, so a wallet that never proves does not bundle it.

import type { WasmConfig } from "../../configure-wasm.js";
import { configureJubjubWasm } from "../../crypto/jubjub-wasm/loader.js";
import { configurePoseidonWasm } from "../../crypto/poseidon-wasm/loader.js";

export async function configureWalletWasm(cfg: WasmConfig): Promise<void> {
    if (cfg.jubjub) configureJubjubWasm(cfg.jubjub);
    if (cfg.poseidon) configurePoseidonWasm(cfg.poseidon);
    if (cfg.prover) {
        const { configureProverWasm } = await import("../../runtime/wasm/prover-loader.js");
        configureProverWasm(cfg.prover);
    }
}
