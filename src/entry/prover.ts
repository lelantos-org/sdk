// `@lelantos-org/sdk/prover`: proving backends and artifact resolution.
//
// `WasmProver` loads `circom_runtime` lazily on first build, and `SnarkjsProver` loads `snarkjs`
// lazily, so importing this entry needs neither optional peer. The worker bootstrap is the
// `./workers/prover` subpath.

export {
    configureArtifactCache,
    type LoadArtifactOpts,
    loadArtifactBytes,
} from "../prover/artifact-bytes.js";
export {
    ARTIFACT_CACHE_NAME,
    type ArtifactCache,
    cacheApiArtifactCache,
    clearArtifactCache,
} from "../prover/artifact-cache.js";
export { bundledProverArtifacts, resolveArtifacts } from "../prover/artifact-paths.js";
export { type PreloadOpts, preloadWasm } from "../prover/preload.js";
export { SnarkjsProver } from "../prover/snarkjs.js";
export type { Groth16Proof, ProveResult, Prover, ProverArtifacts } from "../prover/types.js";
export { WasmProver } from "../prover/wasm-prover.js";
export {
    type BrowserWorkerProverOpts,
    browserWorkerProver,
    WorkerProver,
    type WorkerProverOpts,
} from "../prover/worker-client.js";
export type { WorkerSetup } from "../prover/worker-protocol.js";
export type { WasmLoaderOverride, WasmModuleBase } from "../runtime/wasm/loader.js";
export {
    configureProverThreads,
    configureProverWasm,
    type ProverModule,
    type ProverWasmLoader,
} from "../runtime/wasm/prover-loader.js";
