// Chain access: the `ChainAdapter` port, its data shapes, the viem-based
// default implementation, signers, and network presets.

export {
    type Eip1193ProviderLike,
    Eip1193Signer,
    type EthSigner,
    PrivateKeySigner,
} from "./eth-signer.js";
export {
    type DeployedNetworkPreset,
    isNetworkDeployed,
    NETWORKS,
    type NetworkName,
    type NetworkPreset,
    resolveNetwork,
} from "./networks.js";
export type {
    AllowanceTransferChain,
    ChainAdapter,
    NativeEthChain,
} from "./port.js";
export { supportsAllowanceTransfer, supportsNativeEth } from "./port.js";
export type {
    AssetEntry,
    CancelIntentInputs,
    EscrowedIntentView,
    IntentEscrowedRecord,
    Permit2SignArgs,
    TokenMeta,
} from "./types.js";
export { MASP_ABI, ViemChainAdapter, type ViemChainAdapterOpts } from "./viem/index.js";
