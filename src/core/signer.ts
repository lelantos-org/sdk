// Signer ports. Interfaces only — implementations live in `chain/signer/`.
//
// At tier 0 so `keys/` and `protocol/` can name an `EthSigner` without
// depending on the chain adapter that provides one.

import type { TypedDataDomain, TypedDataParameter } from "viem";
import type { EvmAddress, Hex32 } from "./brand.js";

/** Minimal signer the SDK needs from any wallet. */
export interface EthSigner {
    /**
     * Chain id pinned at construction so EIP-712 builders don't re-query
     * the RPC.
     */
    readonly chainId: bigint;
    getAddress(): Promise<EvmAddress>;
    /** Sign EIP-712 typed-data. Returns 0x-prefixed 65-byte hex. */
    signTypedData(
        domain: TypedDataDomain,
        types: Record<string, TypedDataParameter[]>,
        primaryType: string,
        message: Record<string, unknown>,
    ): Promise<string>;
    /** Submit a raw EVM transaction. Returns the broadcast hash. */
    sendTransaction(args: { to: EvmAddress; data?: `0x${string}`; value?: bigint }): Promise<Hex32>;
}

export interface Eip1193ProviderLike {
    request(args: { method: string; params?: unknown[] | undefined }): Promise<unknown>;
}
