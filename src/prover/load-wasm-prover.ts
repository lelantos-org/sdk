// Dynamic import of `wasm-prover.js` that reports a module that cannot load.
//
// `wasm-prover.ts` imports its `circom_runtime` peer lazily, on the first build (`WasmProver.build`
// reports its absence itself), so a failure here is the module graph — the wasm-pack glue or the
// prover module not resolving in this runtime — not a missing peer.
//
// A separate module so the worker entry can share the guard without importing
// the jubjub warmup from `preload.ts`.

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
