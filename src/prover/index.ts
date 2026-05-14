// Public surface of the `prover` domain — Prover interface, snarkjs and
// WASM backends, presets, preload helpers, worker glue.
//
// `./worker.ts` is intentionally NOT re-exported from this barrel. It is
// the wasm-bindgen-rayon worker bootstrap entrypoint and is published as
// the separate `@lelantos-org/sdk/prover-worker` subpath export. Pulling
// it through the main barrel would drag rayon worker glue into every
// consumer's bundle even when `useWasmProver: false`. Apps that need the
// worker import it directly from the subpath.

export type { ProverArtifacts } from "./artifacts.js";
export * from "./interface.js";
export * from "./preload.js";
export * from "./presets.js";
export * from "./snarkjs.js";
export * from "./wasm-prover.js";
export {
    type BrowserWorkerProverOpts,
    browserWorkerProver,
    WorkerProver,
    type WorkerProverOpts,
} from "./worker-client.js";
// `worker.ts` is the worker bootstrap entrypoint — published as a separate
// package export, intentionally NOT re-exported from the barrel to keep it
// out of the main bundle graph.
