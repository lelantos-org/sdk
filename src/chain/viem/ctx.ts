// Shared state and cast helpers for the viem adapter's call modules.
//
// This adapter is the trust boundary between viem's structural hex types and
// the SDK's branded ones: values read off the chain are branded here, and
// branded values pass straight back into viem, which accepts them because a
// brand is an intersection over the same `0x${string}`. `as never` is reserved
// for the spots where viem's `encodeFunctionData` generic cannot infer a tuple
// argument.

import type { PublicClient } from "viem";
import { branded, type EvmAddress } from "../../core/brand.js";
import type { EthSigner } from "../../core/signer.js";

export interface ViemCtx {
    readonly publicClient: PublicClient;
    readonly signer: EthSigner;
    readonly maspAddress: EvmAddress;
    readonly permit2Address: EvmAddress;
    /**
     * `NativeAdapter`, when one is deployed for this pool. Undefined on a
     * chain without it, which is what makes the native-coin paths optional:
     * the pool is ERC-20 only, so there is no fallback entry point to try.
     */
    readonly nativeAdapterAddress?: EvmAddress | undefined;
    /** Resolves the chain id, caching after the first RPC round trip. */
    chainId(): Promise<bigint>;
}

/** Brand a caller-supplied address string. */
export function addr(s: string): EvmAddress {
    return branded<EvmAddress>(s);
}

/** Narrow a caller-supplied hex string (tx data, signature). */
export function hex(s: string): `0x${string}` {
    return s as `0x${string}`;
}
