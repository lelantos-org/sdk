// Network presets resolve chainId/MASP/relayer/fmd/treeDepth in one keyword.

import type { EvmAddress, EvmAddressLike } from "../core/brand.js";

export interface NetworkPreset {
    chainId: bigint;
    /** `null` marks a placeholder; `connect()` throws `NetworkNotDeployedError`. */
    maspAddress: EvmAddressLike | null;
    /** SNARK-bound. Same `null` semantics as `maspAddress`. */
    relayerAddress: EvmAddressLike | null;
    relayerUrl: string;
    fmdUrl: string;
    treeDepth: number;
    /** Defaults to canonical CREATE2 deployment. */
    permit2Address?: EvmAddressLike;
    /** Surfaced in `NetworkNotDeployedError`. */
    deploymentStatusUrl?: string;
}

// Addresses are asserted rather than run through `evmAddress()` so the table
// stays a pure declaration and `sideEffects: false` holds. `networks.test.ts`
// validates every literal.

/** `sepolia` is a placeholder pending public deployment. */
export const NETWORKS = {
    anvil: {
        chainId: 31337n,
        maspAddress: "0x0165878A594ca255338adfa4d48449f69242Eb8F" as EvmAddress,
        relayerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as EvmAddress,
        relayerUrl: "http://localhost:3000",
        fmdUrl: "http://localhost:3001",
        treeDepth: 10,
    },
    /** Alias for `anvil`; kept distinct for future divergence. */
    localnet: {
        chainId: 31337n,
        maspAddress: "0x0165878A594ca255338adfa4d48449f69242Eb8F" as EvmAddress,
        relayerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as EvmAddress,
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
    base: {
        chainId: 8453n,
        maspAddress: "0x2887cDe0763178e199A99289dbA9b46DB4d9DB2e" as EvmAddress,
        relayerAddress: "0x5Fde731cD64f4D22BD0Ab6Fe690C8a19E5fA4BC8" as EvmAddress,
        relayerUrl: "https://relayer.lelantos.xyz",
        fmdUrl: "https://fmd.lelantos.xyz",
        treeDepth: 10,
    },
    arbitrum: {
        chainId: 42161n,
        maspAddress: "0x2887cDe0763178e199A99289dbA9b46DB4d9DB2e" as EvmAddress,
        relayerAddress: "0x5Fde731cD64f4D22BD0Ab6Fe690C8a19E5fA4BC8" as EvmAddress,
        relayerUrl: "https://relayer.lelantos.xyz",
        fmdUrl: "https://fmd.lelantos.xyz",
        treeDepth: 10,
    },
    mainnet: {
        chainId: 1n,
        maspAddress: "0x2887cDe0763178e199A99289dbA9b46DB4d9DB2e" as EvmAddress,
        relayerAddress: "0x5Fde731cD64f4D22BD0Ab6Fe690C8a19E5fA4BC8" as EvmAddress,
        relayerUrl: "https://relayer.lelantos.xyz",
        fmdUrl: "https://fmd.lelantos.xyz",
        treeDepth: 10,
    },
} as const satisfies Record<string, NetworkPreset>;

export type NetworkName = keyof typeof NETWORKS;

/**
 * The subset of {@link NetworkName} whose preset carries both addresses.
 *
 * Derived from the literals in `NETWORKS`, so a name flips from placeholder to
 * usable the moment its deployment lands — and until then, passing it to
 * `connect()` is a compile error rather than a `NetworkNotDeployedError` at
 * runtime.
 */
export type DeployedNetworkName = {
    [K in NetworkName]: (typeof NETWORKS)[K]["maspAddress"] extends null ? never : K;
}[NetworkName];

/** Names present in `NETWORKS` but not yet deployed. */
export type PlaceholderNetworkName = Exclude<NetworkName, DeployedNetworkName>;

/** Throws on unknown name. */
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

/** Both addresses guaranteed non-null. */
export interface DeployedNetworkPreset extends NetworkPreset {
    maspAddress: EvmAddress;
    relayerAddress: EvmAddress;
}

export function isNetworkDeployed(preset: NetworkPreset): preset is DeployedNetworkPreset {
    return preset.maspAddress !== null && preset.relayerAddress !== null;
}
