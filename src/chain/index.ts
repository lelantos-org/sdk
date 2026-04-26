// Public surface of the `chain` domain — `ChainAdapter` interface,
// viem-based default adapter, network presets.

export * from "./adapter.js";
export * from "./eth-signer.js";
export {
    NETWORKS,
    type NetworkName,
    type NetworkPreset,
    resolveNetwork,
} from "./networks.js";
export * from "./viem-adapter.js";
