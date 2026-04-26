// wasm-bindgen-rayon thread-pool integration: the Node global stubs
// (`node-globals.ts`), the Node worker adapter (`node-worker.ts`), and
// browser/Node pool bring-up (`pool.ts`).

export { installWorkerGlobals, withWorkerGlobals } from "./node-globals.js";
export {
    installNodeRayonWorker,
    rayonWorkerCount,
    shutdownRayonWorkers,
} from "./node-worker.js";
export {
    initBrowserThreadPool,
    initNodeThreadPool,
    type RayonInitOpts,
    type RayonModule,
    type RayonOutcome,
} from "./pool.js";
