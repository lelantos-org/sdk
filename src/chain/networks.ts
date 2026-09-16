// Network presets resolve chainId/MASP/relayer/fmd/treeDepth in one keyword.

import type { EvmAddress, EvmAddressLike } from "../core/brand.js";
import { WalletConfigError } from "../errors/config.js";

/**
 * A deployed network: everything `connect()` needs to reach it.
 *
 * Both addresses are required. A placeholder (not yet deployed) is a {@link PlaceholderNetworkPreset},
 * which `connect()` does not accept, so naming one fails to compile.
 */
export interface NetworkPreset {
    chainId: bigint;
    maspAddress: EvmAddressLike;
    /**
     * SNARK-bound as `pi.relayer`: the relayer's published submitter (its `Bundler` where it
     * bundles), not its signing EOA.
     */
    relayerAddress: EvmAddressLike;
    relayerUrl: string;
    fmdUrl: string;
    /** MetaQuoter base URL. Without it `capabilities.swap` is `false`. */
    quoterUrl?: string | undefined;
    /**
     * JSON-RPC endpoint for chain reads. `NetworkOptions.rpcUrl` overrides it. `anvil` ships
     * `http://localhost:8545`; public networks ship none, since a shared default endpoint would
     * rate-limit and observe every user.
     */
    rpcUrl?: string | undefined;
    treeDepth: number;
    /** Defaults to the canonical CREATE2 deployment. */
    permit2Address?: EvmAddressLike | undefined;
    /** `NativeAdapter`. Without it `capabilities.nativeDeposit` and `nativeWithdraw` are `false`. */
    nativeAdapterAddress?: EvmAddressLike | undefined;
    /** `SwapWrapper`. Else read from the relayer's `/chains` (TTL-cached). */
    swapWrapperAddress?: EvmAddressLike | undefined;
    /**
     * Per-attempt submit deadline in ms: block time plus bundling wait. `HttpOptions.submitTimeoutMs`
     * overrides it. Default 30 000.
     */
    submitTimeoutMs?: number | undefined;
}

/** A `NETWORKS` entry whose contracts are not deployed. Listed for discovery only. */
export interface PlaceholderNetworkPreset
    extends Omit<NetworkPreset, "maspAddress" | "relayerAddress"> {
    maspAddress: null;
    relayerAddress: null;
    /** Surfaced in `NetworkNotDeployedError`. */
    deploymentStatusUrl?: string | undefined;
}

// Addresses are asserted rather than run through `evmAddress()` so the table
// stays a pure declaration and `sideEffects: false` holds. `networks.test.ts`
// validates every literal.

/** `sepolia` is a placeholder pending public deployment. */
export const NETWORKS = {
    /**
     * The `backend/stack` compose stack: anvil on 8545, `fmd-webserver` on 3001, `relayer` on 3003,
     * `metaquoter` on 8081, tree depth 11.
     *
     * The contract addresses are deploy-dependent: the stack's one-shot deploy mints them from the
     * deployer's nonce, and `just redeploy` mints new ones. The values here are those of a first
     * deploy on a fresh anvil at the time of writing. Read the live ones with `just addresses` and
     * override: `{ ...NETWORKS.anvil, maspAddress: MASP, relayerAddress: BUNDLER,
     * nativeAdapterAddress: NATIVE_ADAPTER, swapWrapperAddress: SWAP_WRAPPER }`. `relayerAddress`
     * must be the relayer's `Bundler`, which the stack's relayer submits through.
     */
    anvil: {
        chainId: 31337n,
        maspAddress: "0x0165878A594ca255338adfa4d48449f69242Eb8F" as EvmAddress,
        relayerAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as EvmAddress,
        relayerUrl: "http://localhost:3003",
        fmdUrl: "http://localhost:3001",
        quoterUrl: "http://localhost:8081",
        rpcUrl: "http://localhost:8545",
        treeDepth: 11,
    },
    sepolia: {
        chainId: 11155111n,
        maspAddress: null,
        relayerAddress: null,
        relayerUrl: "https://sepolia.relayer.lelantos.xyz",
        fmdUrl: "https://sepolia.fmd.lelantos.xyz",
        treeDepth: 10,
        deploymentStatusUrl: "https://docs.lelantos.xyz/guide/networks",
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
        // 12s blocks: the default 30s leaves a submit two blocks to land.
        submitTimeoutMs: 90_000,
    },
} as const satisfies Record<string, NetworkPreset | PlaceholderNetworkPreset>;

export type NetworkName = keyof typeof NETWORKS;

/**
 * The subset of {@link NetworkName} whose preset carries both addresses.
 *
 * Derived from the literals in `NETWORKS`, so passing a placeholder name to
 * `connect()` is a compile error rather than a `NetworkNotDeployedError` at
 * runtime.
 */
export type DeployedNetworkName = {
    [K in NetworkName]: (typeof NETWORKS)[K]["maspAddress"] extends null ? never : K;
}[NetworkName];

/** Names present in `NETWORKS` but not yet deployed. */
export type PlaceholderNetworkName = Exclude<NetworkName, DeployedNetworkName>;

/** Throws `WALLET_CONFIG` on an unknown name. */
export function resolveNetwork(
    name: NetworkName | NetworkPreset | PlaceholderNetworkPreset,
): NetworkPreset | PlaceholderNetworkPreset {
    if (typeof name === "string") {
        const p = (NETWORKS as Record<string, NetworkPreset | PlaceholderNetworkPreset>)[name];
        if (!p) {
            const known = Object.keys(NETWORKS).join(", ");
            throw new WalletConfigError(`unknown network "${name}"; known: ${known}`);
        }
        return p;
    }
    return name;
}

/** Whether both addresses are present; a JS caller can still pass a placeholder by name. */
export function isNetworkDeployed(
    preset: NetworkPreset | PlaceholderNetworkPreset,
): preset is NetworkPreset {
    return preset.maspAddress !== null && preset.relayerAddress !== null;
}
