// Chain-layer construction from `connect()` inputs.

import type { NetworkPreset } from "../../chain/networks.js";
import type { ChainReader } from "../../chain/port.js";
import { evmAddress } from "../../core/brand.js";
import { WalletConfigError } from "../../errors/config.js";
import type { Eip1193ProviderLike, EthSigner } from "../../keys/signer.js";

interface ChainAdapterInputs {
    /** Pre-built adapter; the caller owns its construction and signer. */
    chain?: ChainReader | undefined;
    /** Pre-built read-only layer. No deposits. */
    reader?: ChainReader | undefined;
    /**
     * Build a read-only `ViemChainReader` from `rpcUrl` alone, for a wallet without an EVM key
     * (e.g. a passkey). Spending needs no signer; deposits are refused at the call.
     */
    readOnly?: boolean | undefined;
    signer?: EthSigner | undefined;
    /** Browser: a raw EIP-1193 provider and the signing account. */
    provider?: Eip1193ProviderLike | undefined;
    address?: string | undefined;
    /** 0x-hex private key for Node tests and scripts. */
    privateKey?: `0x${string}` | undefined;
    /** Already resolved: the option, else the preset's. */
    rpcUrl?: string | undefined;
    /** RPC `fetch` (`HttpOptions.fetch`). */
    fetch?: typeof fetch | undefined;
}

/** What a viem reader or adapter for `preset` is built from. */
export function viemChainOptions(
    preset: NetworkPreset,
    rpcUrl: string,
    fetchImpl: typeof fetch | undefined,
) {
    return {
        rpcUrl,
        maspAddress: preset.maspAddress,
        chainId: preset.chainId,
        permit2Address: preset.permit2Address,
        nativeAdapterAddress: preset.nativeAdapterAddress,
        ...(fetchImpl ? { fetch: fetchImpl } : {}),
    };
}

/**
 * Build the chain layer `connect()` was asked for.
 *
 * viem and the signers load dynamically, so a caller supplying `chain` never loads the viem client
 * stack (~230 KB) and others load it on demand. Validation runs before the import so a
 * misconfigured call fails without fetching anything.
 */
export async function defaultChainAdapter(
    inputs: ChainAdapterInputs,
    preset: NetworkPreset,
): Promise<ChainReader> {
    if (inputs.chain) return inputs.chain;
    if (inputs.reader) return inputs.reader;

    const rpcUrl = inputs.rpcUrl;
    if (!rpcUrl) {
        throw new WalletConfigError(
            "`rpcUrl` (on the preset or in the options) — required to build a chain layer; " +
                "or pass a pre-built `chain` or `reader`",
        );
    }
    const common = viemChainOptions(preset, rpcUrl, inputs.fetch);

    if (inputs.readOnly) {
        const { ViemChainReader } = await import("../../chain/viem/index.js");
        return new ViemChainReader(common);
    }
    if (!inputs.signer && !(inputs.provider && inputs.address) && !inputs.privateKey) {
        throw new WalletConfigError(
            "pass one of `chain`, `reader`, `readOnly`, `signer`, `{ provider, address }` or `privateKey`",
        );
    }

    const [{ Eip1193Signer }, { PrivateKeySigner }, { ViemChainAdapter }] = await Promise.all([
        import("../../chain/signer/eip1193.js"),
        import("../../chain/signer/private-key.js"),
        import("../../chain/viem/index.js"),
    ]);

    const signer: EthSigner =
        inputs.signer ??
        (inputs.provider && inputs.address
            ? new Eip1193Signer(inputs.provider, evmAddress(inputs.address), preset.chainId)
            : new PrivateKeySigner(inputs.privateKey as `0x${string}`, rpcUrl, preset.chainId));

    return new ViemChainAdapter({ ...common, signer });
}
