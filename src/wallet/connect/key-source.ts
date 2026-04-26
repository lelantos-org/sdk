// Turning `ConnectOptions` into a `KeySource`, and detecting the runtime.

import type { ChainAdapter } from "../../chain/port.js";
import { WalletConfigError } from "../../core/errors.js";
import type { Eip1193ProviderLike, EthSigner } from "../../core/signer.js";
import type { KeySource } from "../../keys/key-source.js";
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

export function detectRuntime(): "node" | "browser" {
    const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
    return isBrowser ? "browser" : "node";
}

export function buildKeySource(opts: ConnectOptionsLoose): KeySource {
    const provided = [
        opts.mnemonic !== undefined,
        opts.signature !== undefined,
        opts.nsk !== undefined,
    ].filter(Boolean).length;
    if (provided === 0) {
        throw new WalletConfigError("pass exactly one of `mnemonic`, `signature`, or `nsk`");
    }
    if (provided > 1) {
        throw new WalletConfigError(
            "pass exactly one of `mnemonic`, `signature`, or `nsk` (multiple supplied)",
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
