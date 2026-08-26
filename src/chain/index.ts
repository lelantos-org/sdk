// Chain access: the `ChainAdapter` port, its data shapes, the viem-based
// default implementation, signers, and network presets.

export {
    type Eip1193ProviderLike,
    Eip1193Signer,
    type EthSigner,
    PrivateKeySigner,
} from "./eth-signer.js";
export {
    type DeployedNetworkName,
    type DeployedNetworkPreset,
    isNetworkDeployed,
    NETWORKS,
    type NetworkName,
    type NetworkPreset,
    type PlaceholderNetworkName,
    resolveNetwork,
} from "./networks.js";
export type {
    AllowanceBatchChain,
    AllowanceTransferChain,
    ChainAdapter,
    NativeEthChain,
} from "./port.js";
export { supportsAllowanceBatch, supportsAllowanceTransfer, supportsNativeEth } from "./port.js";
export type {
    AssetEntry,
    CancelDepositInputs,
    DepositEscrowedRecord,
    EscrowedDepositView,
    Permit2SignArgs,
    TokenMeta,
} from "./types.js";
export {
    MASP_ABI,
    NATIVE_ADAPTER_ABI,
    ViemChainAdapter,
    type ViemChainAdapterOpts,
} from "./viem/index.js";
