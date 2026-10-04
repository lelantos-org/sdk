// Dynamic import of `wasm-prover.js` that reports a module that cannot load.
//
// `circom_runtime` is imported lazily by `WasmProver.build`, which reports its absence itself, so
// a failure here means the module graph (the wasm-pack glue or the prover module) does not
// resolve in this runtime, not a missing peer.
//
// A separate module so the worker entry can share the guard without importing the jubjub warmup
// from `preload.ts`.

import { ProverUnavailableError } from "../errors/prover.js";

type WasmProverModule = typeof import("./wasm-prover.js");

export async function loadWasmProver(): Promise<WasmProverModule> {
    try {
        return await import("./wasm-prover.js");
    } catch (e) {
        throw new ProverUnavailableError(
            "the WASM prover module failed to load in this runtime. Pass another backend, or " +
                '`prover: "none"`, to skip it.',
            { cause: e },
        );
    }
}
