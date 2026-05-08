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
    /// MASP contract address (used by the chain adapter).
    maspAddress: string;
    /// Relayer signer address. SNARK-bound — must equal the deployment's
    /// relayer pipeline address.
    relayerAddress: string;
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
}

/// Builtin presets. Localnet/anvil match the `contracts/` deploy script
/// defaults; mainnet/testnet are placeholders pending public deployment.
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
