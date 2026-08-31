// Dynamic access to `wasm-prover.js`, with the optional-peer failure named.
//
// `wasm-prover.ts` statically imports `circom_runtime`, which is an optional
// peer — so every dynamic import of it is a place a consumer who never
// installed one finds out. Left bare, that surfaces as a module-resolution
// error pointing at a file inside this package, which reads like a bug in the
// SDK rather than a missing dependency in the app.
//
// A module of its own rather than a helper inside `preload.ts`: the worker
// entry needs the same guard, and importing it from `preload` would pull the
// jubjub warmup into the worker for nothing.

import { ProverError } from "../core/errors.js";

export type WasmProverModule = typeof import("./wasm-prover.js");

export async function loadWasmProver(): Promise<WasmProverModule> {
    try {
        return await import("./wasm-prover.js");
    } catch (e) {
        throw new ProverError(
            "the WASM prover needs `circom_runtime`, an optional peer. Install it " +
                "(`npm i circom_runtime`), or pass `{ prover: false }` to skip it.",
            { cause: e },
        );
    }
}
