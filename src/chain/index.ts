// Public surface of the `chain` domain — `ChainAdapter` interface,
// ethers-based default adapter, network presets.

export * from "./adapter.js";
export * from "./ethers-adapter.js";
export {
    NETWORKS,
    type NetworkName,
    type NetworkPreset,
    resolveNetwork,
} from "./networks.js";
