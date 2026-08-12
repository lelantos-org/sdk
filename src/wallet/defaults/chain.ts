// Chain-adapter construction from `connect()` inputs.

import type { DeployedNetworkPreset } from "../../chain/networks.js";
import type { ChainAdapter } from "../../chain/port.js";
import { evmAddress } from "../../core/brand.js";
import { WalletConfigError } from "../../core/errors.js";
import type { Eip1193ProviderLike, EthSigner } from "../../core/signer.js";

export interface ChainAdapterInputs {
    chain?: ChainAdapter | undefined;
    /** Pre-built signer (EIP-1193 wrapper, private key signer, etc.). */
    signer?: EthSigner | undefined;
    /**
     * Browser-style entry: raw EIP-1193 provider + the signing account +
     * chainId. SDK builds an `Eip1193Signer` internally.
     */
    provider?: Eip1193ProviderLike | undefined;
    address?: `0x${string}` | undefined;
    /** 0x-hex private key for Node tests / CLI builds. */
    privateKey?: `0x${string}` | undefined;
    rpcUrl?: string | undefined;
}

/**
 * Build the default `ViemChainAdapter`. Used by `connect()` when the caller
 * passes `signer` / `provider` / `privateKey` rather than a pre-built adapter.
 *
 * viem and the signers load dynamically: a caller who supplies their own
 * `chain` never pays for the viem client stack (~230 KB), and one who does not
 * pays for it off `connect()`'s critical path rather than at module load.
 * Validation stays ahead of the import so a misconfigured call still fails
 * without fetching anything.
 */
export async function defaultChainAdapter(
    inputs: ChainAdapterInputs,
    preset: DeployedNetworkPreset,
): Promise<ChainAdapter> {
    if (inputs.chain) return inputs.chain;

    const errs: string[] = [];
    if (!inputs.rpcUrl) {
        errs.push("`rpcUrl` required when building chain adapter (or pass a pre-built `chain`)");
    }
    if (!inputs.signer && !(inputs.provider && inputs.address) && !inputs.privateKey) {
        errs.push("pass one of `chain`, `signer`, `{provider,address}`, or `privateKey`");
    }
    if (errs.length) throw new WalletConfigError(errs);

    const [{ Eip1193Signer, PrivateKeySigner }, { ViemChainAdapter }] = await Promise.all([
        import("../../chain/eth-signer.js"),
        import("../../chain/viem/index.js"),
    ]);

    const signer: EthSigner =
        inputs.signer ??
        (inputs.provider && inputs.address
            ? new Eip1193Signer(inputs.provider, evmAddress(inputs.address), preset.chainId)
            : new PrivateKeySigner(
                  inputs.privateKey as `0x${string}`,
                  inputs.rpcUrl as string,
                  preset.chainId,
              ));

    return new ViemChainAdapter({
        rpcUrl: inputs.rpcUrl as string,
        signer,
        maspAddress: preset.maspAddress,
        chainId: preset.chainId,
        permit2Address: preset.permit2Address,
    });
}

/** Inputs `connect()` collects to wire a default browser/node prover. */
