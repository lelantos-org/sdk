// Browser-wallet signer: everything goes through `provider.request`, so
// prompts land in the wallet the user connected with.

import type { TypedDataDomain, TypedDataParameter } from "viem";
import { branded, type EvmAddress, type Hex32 } from "../../core/brand.js";
import type { Eip1193ProviderLike, EthSigner } from "../../core/signer.js";
import { domainTypes, serialisableDomain, stringifyBigInts } from "./typed-data.js";

/**
 * Wraps a raw EIP-1193 provider as `EthSigner` (browser wallets). All
 * signing and broadcast go through `provider.request` so prompts land in
 * the wallet the user connected with.
 */
export class Eip1193Signer implements EthSigner {
    constructor(
        private readonly provider: Eip1193ProviderLike,
        private readonly address: EvmAddress,
        readonly chainId: bigint,
    ) {}

    getAddress(): Promise<EvmAddress> {
        return Promise.resolve(this.address);
    }

    async signTypedData(
        domain: TypedDataDomain,
        types: Record<string, TypedDataParameter[]>,
        primaryType: string,
        message: Record<string, unknown>,
    ): Promise<string> {
        // `eth_signTypedData_v4` expects the JSON-stringified TypedData
        // payload, including an explicit EIP712Domain type.
        const payload = {
            types: { EIP712Domain: domainTypes(domain), ...types },
            primaryType,
            domain: serialisableDomain(domain),
            message: stringifyBigInts(message),
        };
        const sig = (await this.provider.request({
            method: "eth_signTypedData_v4",
            params: [this.address, JSON.stringify(payload)],
        })) as string;
        return sig;
    }

    async sendTransaction(args: {
        to: EvmAddress;
        data?: `0x${string}`;
        value?: bigint;
    }): Promise<Hex32> {
        const params = [
            {
                from: this.address,
                to: args.to,
                ...(args.data ? { data: args.data } : {}),
                ...(args.value !== undefined ? { value: `0x${args.value.toString(16)}` } : {}),
            },
        ];
        const hash = (await this.provider.request({
            method: "eth_sendTransaction",
            params,
        })) as string;
        return branded<Hex32>(hash);
    }
}
