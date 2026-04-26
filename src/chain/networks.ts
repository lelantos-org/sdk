// Network presets resolve chainId/MASP/relayer/fmd/treeDepth in one keyword.

export interface NetworkPreset {
    chainId: bigint;
    /// `null` marks a placeholder; `connect()` throws `NetworkNotDeployedError`.
    maspAddress: string | null;
    /// SNARK-bound. Same `null` semantics as `maspAddress`.
    relayerAddress: string | null;
    relayerUrl: string;
    fmdUrl: string;
    treeDepth: number;
    /// Defaults to canonical CREATE2 deployment.
    permit2Address?: string;
    /// Surfaced in `NetworkNotDeployedError`.
    deploymentStatusUrl?: string;
}

/// `sepolia`/`mainnet` are placeholders pending public deployment.
export const NETWORKS = {
    anvil: {
        chainId: 31337n,
        maspAddress: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
        relayerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        relayerUrl: "http://localhost:3000",
        fmdUrl: "http://localhost:3001",
        treeDepth: 10,
    },
    /// Alias for `anvil`; kept distinct for future divergence.
    localnet: {
        chainId: 31337n,
        maspAddress: "0x0165878A594ca255338adfa4d48449f69242Eb8F",
        relayerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        relayerUrl: "http://localhost:3000",
        fmdUrl: "http://localhost:3001",
        treeDepth: 10,
    },
    sepolia: {
        chainId: 11155111n,
        maspAddress: null,
        relayerAddress: null,
        relayerUrl: "https://sepolia.relayer.lelantos.org",
        fmdUrl: "https://sepolia.fmd.lelantos.org",
        treeDepth: 10,
        deploymentStatusUrl: "https://docs.lelantos.org/deployments",
    },
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

/// Throws on unknown name.
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

/// Both addresses guaranteed non-null.
export interface DeployedNetworkPreset extends NetworkPreset {
    maspAddress: string;
    relayerAddress: string;
}

export function isNetworkDeployed(preset: NetworkPreset): preset is DeployedNetworkPreset {
    return preset.maspAddress !== null && preset.relayerAddress !== null;
}
