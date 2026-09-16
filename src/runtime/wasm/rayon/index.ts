// wasm-bindgen-rayon thread-pool integration: the Node global stubs
// (`node-globals.ts`), the Node worker adapter (`node-worker.ts`), and
// browser/Node pool bring-up (`pool.ts`).

export { withWorkerGlobals } from "./node-globals.js";
export { rayonWorkerCount, shutdownRayonWorkers } from "./node-worker.js";
export { initThreadPool } from "./pool.js";
