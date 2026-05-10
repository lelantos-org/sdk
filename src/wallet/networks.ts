// Network presets bundle the chain-id, MASP address, relayer address +
// URL, fmd-webserver URL, and tree depth for known deployments. Lets
// `Wallet.connect({ network: "anvil" })` resolve all six fields in one
// keyword instead of asking app authors to memorise + duplicate them.
//
// Add a new entry here when a deployment is added; consumers don't need to
// touch anything else.

export interface NetworkPreset {
    /// EVM chain id. Must match the contract + circuit build.
    chainId: bigint;
    /// MASP contract address (used by the chain adapter). `null` marks
    /// a placeholder preset (network is reserved but contracts are not
    /// yet deployed); `connect()` throws `NetworkNotDeployedError` so
    /// callers see a clear error instead of a cryptic "invalid address"
    /// failure later.
    maspAddress: string | null;
    /// Relayer signer address. SNARK-bound — must equal the deployment's
    /// relayer pipeline address. Same `null` semantics as `maspAddress`.
    relayerAddress: string | null;
    /// Relayer base URL.
    relayerUrl: string;
    /// fmd-webserver base URL.
    fmdUrl: string;
    /// MASP merkle tree depth.
    treeDepth: number;
    /// Permit2 contract address. Defaults to the canonical CREATE2
    /// deployment; override per-deployment if a non-standard Permit2 is
    /// used (e.g. anvil snapshots that re-deploy at a different addr).
    permit2Address?: string;
    /// Documentation URL surfaced in `NetworkNotDeployedError` so
    /// integrators can find current deployment status.
    deploymentStatusUrl?: string;
}

/// Builtin presets. Localnet/anvil match the `contracts/` deploy script
/// defaults. `sepolia`/`mainnet` are reserved placeholders — addresses
/// land here once the public deployment ships, so integrators can pick
/// them by name today and the SDK upgrade is the only change needed.
export const NETWORKS = {
    /// Foundry / anvil dev chain (chainId 31337). Matches
    /// `cast send` defaults from the contracts repo.
    anvil: {
        chainId: 31337n,
        maspAddress: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
        relayerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        relayerUrl: "http://localhost:3000",
        fmdUrl: "http://localhost:3001",
        treeDepth: 10,
    },
    /// Alias for `anvil` — kept distinct so future localnet variants can
    /// diverge without breaking existing imports.
    localnet: {
        chainId: 31337n,
        maspAddress: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
        relayerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        relayerUrl: "http://localhost:3000",
        fmdUrl: "http://localhost:3001",
        treeDepth: 10,
    },
    /// Ethereum Sepolia testnet. Placeholder — no public deployment yet.
    sepolia: {
        chainId: 11155111n,
        maspAddress: null,
        relayerAddress: null,
        relayerUrl: "https://sepolia.relayer.lelantos.org",
        fmdUrl: "https://sepolia.fmd.lelantos.org",
        treeDepth: 10,
        deploymentStatusUrl: "https://docs.lelantos.org/deployments",
    },
    /// Ethereum mainnet. Placeholder — no public deployment yet.
    mainnet: {
        chainId: 1n,
        maspAddress: null,
        relayerAddress: null,
        relayerUrl: "https://relayer.lelantos.org",
        fmdUrl: "https://fmd.lelantos.org",
        treeDepth: 10,
        deploymentStatusUrl: "https://docs.lelantos.org/deployments",
    },
} as const satisfies Record<string, NetworkPreset>;

export type NetworkName = keyof typeof NETWORKS;

/// Resolve a preset by name. Throws for unknown names so typos surface
/// immediately rather than failing later with a misleading "missing
/// fmdUrl" error.
export function resolveNetwork(name: NetworkName | NetworkPreset): NetworkPreset {
    if (typeof name === "string") {
        const p = NETWORKS[name];
        if (!p) {
            const known = Object.keys(NETWORKS).join(", ");
            throw new Error(`unknown network "${name}"; known: ${known}`);
        }
        return p;
    }
    return name;
}

/// Preset narrowed to a fully-deployed shape. Returned by
/// `assertNetworkDeployed`; both addresses are guaranteed non-null.
export interface DeployedNetworkPreset extends NetworkPreset {
    maspAddress: string;
    relayerAddress: string;
}

/// `true` when the preset has concrete on-chain addresses. Use to gate
/// UI on the readiness of a placeholder network preset.
export function isNetworkDeployed(preset: NetworkPreset): preset is DeployedNetworkPreset {
    return preset.maspAddress !== null && preset.relayerAddress !== null;
}
