// Shared state and cast helpers for the viem adapter's call modules.
//
// The adapter is the trust boundary between viem's structural hex types and
// the SDK's branded ones: values read off the chain are branded here, and
// branded values pass back into viem unchanged, a brand being an intersection
// over the same `0x${string}`. `as never` is reserved for the spots where
// viem's `encodeFunctionData` generic cannot infer a tuple argument.

import type { PublicClient } from "viem";
import { branded, type EvmAddress } from "../../core/brand.js";
import type { EthSigner } from "../../keys/signer.js";

/** State needed for reads, which work without an EVM key. */
export interface ViemReadCtx {
    readonly publicClient: PublicClient;
    readonly maspAddress: EvmAddress;
    readonly permit2Address: EvmAddress;
    /**
     * `NativeAdapter` deployed for this pool, if any. When undefined, native-coin
     * paths are unavailable: the pool is ERC-20 only and has no fallback entry point.
     */
    readonly nativeAdapterAddress?: EvmAddress | undefined;
    /** Resolves the chain id, caching after the first RPC round trip. */
    chainId(): Promise<bigint>;
}

/** A read context that also holds a signing key. */
export interface ViemCtx extends ViemReadCtx {
    readonly signer: EthSigner;
}

/** Brand a caller-supplied address string. */
export function addr(s: string): EvmAddress {
    return branded<EvmAddress>(s);
}

/** Narrow a caller-supplied hex string (tx data, signature). */
export function hex(s: string): `0x${string}` {
    return s as `0x${string}`;
}
