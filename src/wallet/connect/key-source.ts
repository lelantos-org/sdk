// Turning `ConnectOptions` into a `KeySource`, and detecting the runtime.

import type { ChainAdapter } from "../../chain/port.js";
import { WalletConfigError } from "../../core/errors.js";
import type { Eip1193ProviderLike, EthSigner } from "../../core/signer.js";
import type { KeySource } from "../../keys/key-source.js";
import { deriveNskFromSigner } from "../../keys/metamask.js";

/**
 * The `EthSigner` implied by the chain options, if any. A pre-built `chain`
 * adapter yields none: it owns its signer and does not expose it.
 */
async function chainLayerSigner(
    opts: ConnectOptionsLoose,
    chainId: bigint,
): Promise<EthSigner | undefined> {
    if (opts.signer) return opts.signer;
    if (!opts.provider || !opts.address) return undefined;
    const { Eip1193Signer } = await import("../../chain/eth-signer.js");
    const { evmAddress } = await import("../../core/brand.js");
    return new Eip1193Signer(opts.provider, evmAddress(opts.address), chainId);
}

import type { ConnectExtraOptions } from "./options.js";

export type ConnectOptionsLoose = ConnectExtraOptions & {
    mnemonic?: string;
    account?: number;
    passphrase?: string;
    signature?: string;
    nsk?: bigint;
    chain?: ChainAdapter;
    signer?: EthSigner;
    provider?: Eip1193ProviderLike;
    address?: `0x${string}`;
    privateKey?: `0x${string}`;
    rpcUrl?: string;
};

// Re-exported rather than redeclared: `connect()` reaches for it here, and a
// second identical body is how the two answers drift apart.
export { detectRuntime } from "../../core/runtime.js";

/**
 * Resolve the shielded key source.
 *
 * An explicit `mnemonic` / `signature` / `nsk` always wins. Otherwise the
 * chain layer supplies it where it can: a `privateKey` derives one through a
 * domain-separated reduction, and a `signer` or `provider` derives one from a
 * single EIP-712 signature. A pre-built `chain` adapter cannot, since it
 * exposes no signing key, so that combination still needs an explicit source.
 */
export async function buildKeySource(
    opts: ConnectOptionsLoose,
    chainId: bigint,
): Promise<KeySource> {
    const provided = [
        opts.mnemonic !== undefined,
        opts.signature !== undefined,
        opts.nsk !== undefined,
    ].filter(Boolean).length;
    if (provided > 1) {
        throw new WalletConfigError(
            "pass exactly one of `mnemonic`, `signature`, or `nsk` (multiple supplied)",
        );
    }
    if (provided === 0) {
        if (opts.privateKey !== undefined) {
            return { type: "privateKey", hex: opts.privateKey };
        }
        const signer = await chainLayerSigner(opts, chainId);
        if (signer) {
            return { type: "nsk", nsk: await deriveNskFromSigner(signer) };
        }
        throw new WalletConfigError(
            "no shielded key source: pass `mnemonic`, `signature`, or `nsk`, " +
                "or a chain layer that can derive one (`privateKey`, `signer`, `provider`)",
        );
    }
    if (opts.mnemonic !== undefined) {
        return {
            type: "mnemonic",
            mnemonic: opts.mnemonic,
            account: opts.account ?? 0,
            passphrase: opts.passphrase,
        };
    }
    if (opts.signature !== undefined) {
        return { type: "signature", signature: opts.signature };
    }
    return { type: "nsk", nsk: opts.nsk! };
}

/**
 * Single-call wallet construction.
 *
 * ```ts
 * const wallet = await connect({
 *     network: "anvil",
 *     mnemonic: "...",
 *     privateKey: "0x...",
 *     rpcUrl: "http://localhost:8545",
 *     proverArtifacts: { circuit: "/path/to/2x2.wasm", zkey: "/path/to/2x2.zkey" },
 * });
 * ```
 */
