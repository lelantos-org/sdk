// Public surface of the `prover` domain — Prover interface, snarkjs and
// WASM backends, presets, preload helpers, worker glue.
//
// `./worker.ts` is NOT re-exported: it is the wasm-bindgen-rayon worker
// bootstrap entrypoint, published as the `@lelantos-org/sdk/prover-worker`
// subpath export. Re-exporting it here would drag rayon worker glue into
// every consumer's bundle even when `useWasmProver: false`.

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
