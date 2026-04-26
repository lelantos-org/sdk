// Shared state and cast helpers for the viem adapter's call modules.
//
// Two named helpers own the coercion from a caller-guaranteed domain string to
// viem's hex types. `as never` is reserved for the spots where viem's
// `encodeFunctionData` generic cannot infer a tuple argument.

import type { PublicClient } from "viem";
import type { EthSigner } from "../../core/signer.js";

export interface ViemCtx {
    readonly publicClient: PublicClient;
    readonly signer: EthSigner;
    readonly maspAddress: `0x${string}`;
    readonly permit2Address: `0x${string}`;
    /** Resolves the chain id, caching after the first RPC round trip. */
    chainId(): Promise<bigint>;
}

/** Narrow a caller-supplied address string to viem's hex type. */
export function addr(s: string): `0x${string}` {
    return s as `0x${string}`;
}

/** Narrow a caller-supplied hex string (tx data, signature, bytes32). */
export function hex(s: string): `0x${string}` {
    return s as `0x${string}`;
}
