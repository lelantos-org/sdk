// Prover backends and artifact resolution.
//
// `snarkjs` is an optional peer dependency. Only `./snarkjs.js` imports it,
// and only lazily inside `loadSnarkjs()`. Everything else — the port, the
// wasm backend, the worker client, the wallet config — depends on
// `./types.js`, which imports nothing but `core/`. An eager import of the
// snarkjs backend anywhere on the default path would make the optional
// dependency mandatory again.
//
// `./worker/entry` is not re-exported: it is the wasm-bindgen-rayon worker
// bootstrap, published as the `@lelantos-org/sdk/prover-worker` subpath.
// Re-exporting it would drag rayon worker glue into every consumer's bundle
// even with `useWasmProver: false`.

export {
    bundledProverArtifacts,
    loadArtifactBytes,
    type ProverArtifacts,
    resolveArtifacts,
} from "./artifacts.js";
export { type PreloadOpts, preloadWasm } from "./preload.js";
export { prove, SnarkjsProver, verify } from "./snarkjs.js";
export type { Groth16Proof, ProveResult, Prover, ProverPaths } from "./types.js";
export {
    configureProverThreads,
    configureProverWasm,
    type ProverWasmLoader,
    WasmProver,
} from "./wasm-prover.js";
export {
    type BrowserWorkerProverOpts,
    browserWorkerProver,
    WorkerProver,
    type WorkerProverOpts,
} from "./worker-client.js";
