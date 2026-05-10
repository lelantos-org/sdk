// Top-level barrel for `@lelantos-org/sdk`.
//
// Organised by layer so autocomplete groups predictable concepts together.
// Most apps need only the "Connect" + "Wallet" sections; reach for "Crypto
// primitives" when building custom flows or testing circuit parity.

export * from "./address.js";
export * from "./aux.js";
// ── Bundles + relayer wire format ───────────────────────────────────────
export * from "./bundle.js";
export * from "./crypto/index.js";
// ── WASM modules (Baby-Jubjub + Groth16) ────────────────────────────────
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
export * from "./operator.js";
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
// ── Crypto primitives + circuit parity ──────────────────────────────────
// Building blocks reused by the Wallet class. Exposed for tests, e2e
// runners, and apps that need to construct bundles by hand.
export * from "./version.js";
export * from "./wallet/adapters/ethers-chain.js";
// ── Pluggables (interfaces + ship-with defaults) ─────────────────────────
// All six wallet dependencies are interfaces; SDK ships an in-process
// default for each. Swap any one without touching the rest.
export * from "./wallet/chain-adapter.js";
export * from "./wallet/config.js";
// ── Connect (high-level entrypoint) ──────────────────────────────────────
export {
    type ConnectKeyOptions,
    type ConnectOptions,
    connect,
} from "./wallet/connect.js";
export * from "./wallet/errors.js";
export * from "./wallet/fmd-client.js";
// ── Wallet API ───────────────────────────────────────────────────────────
export * from "./wallet/index.js";
export * from "./wallet/hd.js";
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
// `WasmProver` lives at the `@lelantos-org/sdk/wasm-prover` subpath so the
// main barrel does not transitively drag in `wasm-bindgen-rayon` worker
// glue. Browser apps that opt out via `useWasmProver: false` (Wallet.connect)
// pay zero bundle cost. Apps that want the rust prover import the subpath
// directly.
export * from "./wasm/config.js";
export * from "./witness/tree-update.js";
export * from "./witness.js";
