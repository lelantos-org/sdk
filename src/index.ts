// Top-level barrel for `@lelantos-org/sdk`.

export * from "./address.js";
export * from "./aux.js";
export * from "./bundle.js";
export * from "./crypto/index.js";
export {
    buildJubjub,
    configureJubjubWasm,
    type JubjubWasmLoader,
    WasmJubjub,
} from "./crypto/jubjub-wasm.js";
export * from "./fmd.js";
export * from "./keys.js";
export * as metamask from "./metamask.js";
export * from "./note-codec.js";
export * from "./note-encrypt.js";
export * from "./notes.js";
export * from "./permit2.js";
export * from "./preload.js";
export * from "./presets.js";
export * from "./prover.js";
export * from "./relayer.js";
export * from "./snark-compression.js";
export * from "./swap.js";
export * from "./sync.js";
export {
    type EthAddress,
    type Hex,
    type ProverArtifacts,
    parseEthAddress,
    parseHex,
    parseUrl,
    type ShieldedAddress,
    type Url,
    urlToString,
} from "./types.js";
export * from "./version.js";
export * from "./wallet/adapters/ethers-chain.js";
export * from "./wallet/chain-adapter.js";
export * from "./wallet/config.js";
export {
    type ConnectKeyOptions,
    type ConnectOptions,
    connect,
} from "./wallet/connect.js";
export * from "./wallet/errors.js";
export * from "./wallet/fmd-client.js";
export * from "./wallet/hd.js";
export * from "./wallet/index.js";
export * from "./wallet/key-source.js";
export {
    NETWORKS,
    type NetworkName,
    type NetworkPreset,
    resolveNetwork,
} from "./wallet/networks.js";
export * from "./wallet/note-source.js";
export * from "./wallet/note-store.js";
export * from "./wallet/prover.js";
export {
    type BrowserWorkerProverOpts,
    browserWorkerProver,
    WorkerProver,
    type WorkerProverOpts,
} from "./wallet/prover-worker-client.js";
export * from "./wallet/randomness.js";
export * from "./wallet/scanner.js";
export * from "./wallet/scanner-worker-pool.js";
export * from "./wallet/scanner-worker-protocol.js";
export * from "./wallet/selection.js";
export * from "./wallet/submitter.js";
export * from "./wallet/sync.js";
// `WasmProver` lives at `@lelantos-org/sdk/wasm-prover` so the main barrel
// does not pull in `wasm-bindgen-rayon` worker glue. Browser apps that opt
// out via `useWasmProver: false` pay zero bundle cost.
export * from "./wasm/config.js";
export * from "./witness.js";
