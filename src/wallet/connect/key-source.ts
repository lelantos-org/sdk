// Turning `ConnectOptions` into a spending key.

import type { ChainAdapter, ChainReader } from "../../chain/port.js";
import { WalletConfigError } from "../../errors/config.js";
import { type KeySource, resolveNsk } from "../../keys/key-source.js";
import { deriveNskFromSigner } from "../../keys/metamask.js";
import type { Eip1193ProviderLike, EthSigner } from "../../keys/signer.js";
import type { ConnectExtras, NetworkPreset } from "./options.js";

/** Widened view of `ConnectOptions` used internally, after the union is enforced at the call site. */
export type ConnectOptionsLoose = ConnectExtras & {
    network: string | NetworkPreset;
    rpcUrl?: string | undefined;
    mnemonic?: string | undefined;
    account?: number | undefined;
    passphrase?: string | undefined;
    signature?: string | undefined;
    nsk?: bigint | undefined;
    chain?: ChainAdapter | undefined;
    reader?: ChainReader | undefined;
    readOnly?: boolean | undefined;
    signer?: EthSigner | undefined;
    provider?: Eip1193ProviderLike | undefined;
    address?: string | undefined;
    privateKey?: `0x${string}` | undefined;
};

/** The explicit key sources present. */
export function explicitKeySources(opts: ConnectOptionsLoose): string[] {
    return (["mnemonic", "signature", "nsk"] as const).filter((k) => opts[k] !== undefined);
}

/**
 * A source that derives with no prompt (`mnemonic`, `signature`, `nsk`, `privateKey`), or
 * `undefined` when the key comes from a signer's EIP-712 signature.
 */
function silentKeySource(opts: ConnectOptionsLoose): KeySource | undefined {
    if (opts.mnemonic !== undefined) {
        return {
            type: "mnemonic",
            mnemonic: opts.mnemonic,
            account: opts.account ?? 0,
            passphrase: opts.passphrase,
        };
    }
    if (opts.signature !== undefined) return { type: "signature", signature: opts.signature };
    if (opts.nsk !== undefined) return { type: "nsk", nsk: opts.nsk };
    if (opts.privateKey !== undefined) return { type: "privateKey", hex: opts.privateKey };
    return undefined;
}

/**
 * The shielded spending key, as a thunk `connect()` calls last.
 *
 * An explicit `mnemonic` / `signature` / `nsk` always wins. Otherwise the chain layer supplies it: a
 * `privateKey` through a domain-separated reduction, a `signer` or `provider` through one EIP-712
 * signature (the only prompt `connect` issues). A pre-built `chain`, `reader` or `readOnly` holds
 * no key; validation has already refused those without an explicit source.
 */
export function keyThunk(opts: ConnectOptionsLoose, chainId: bigint): () => Promise<bigint> {
    return async () => {
        const silent = silentKeySource(opts);
        if (silent) return resolveNsk(silent);
        let signer = opts.signer;
        if (!signer && opts.provider && opts.address) {
            const { Eip1193Signer } = await import("../../chain/signer/eip1193.js");
            const { evmAddress } = await import("../../core/brand.js");
            signer = new Eip1193Signer(opts.provider, evmAddress(opts.address), chainId);
        }
        if (!signer) {
            throw new WalletConfigError(
                "no shielded key source: pass `mnemonic`, `signature`, or `nsk`, " +
                    "or a chain layer that can derive one (`privateKey`, `signer`, `provider`)",
            );
        }
        return deriveNskFromSigner(signer);
    };
}
