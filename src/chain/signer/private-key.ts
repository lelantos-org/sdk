// Local-account signer for Node (tests, scripts, relayer).

import {
    createWalletClient,
    type Hex,
    http,
    type LocalAccount,
    type TypedDataDomain,
    type TypedDataParameter,
    type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { branded, type EvmAddress, type Hex32 } from "../../core/brand.js";
import type { EthSigner } from "../../core/signer.js";

/** Local-account signer for Node (tests, scripts, relayer). */
export class PrivateKeySigner implements EthSigner {
    private readonly account: LocalAccount;
    private readonly wallet: WalletClient;

    constructor(
        privateKey: Hex,
        rpcUrl: string,
        readonly chainId: bigint,
    ) {
        this.account = privateKeyToAccount(privateKey);
        this.wallet = createWalletClient({
            account: this.account,
            transport: http(rpcUrl),
        });
    }

    async getAddress(): Promise<EvmAddress> {
        return branded<EvmAddress>(this.account.address);
    }

    async signTypedData(
        domain: TypedDataDomain,
        types: Record<string, TypedDataParameter[]>,
        primaryType: string,
        message: Record<string, unknown>,
    ): Promise<string> {
        // viem's signTypedData generic can't infer from the abstract EthSigner
        // boundary types; casts are unavoidable here.
        return this.account.signTypedData({
            domain,
            types: types as any,
            primaryType,
            message: message as any,
        });
    }

    async sendTransaction(args: {
        to: EvmAddress;
        data?: `0x${string}`;
        value?: bigint;
    }): Promise<Hex32> {
        const hash = await this.wallet.sendTransaction({
            account: this.account,
            chain: null,
            to: args.to,
            data: args.data,
            value: args.value,
        });
        return branded<Hex32>(hash);
    }
}
