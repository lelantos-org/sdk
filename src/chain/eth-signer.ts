// Wallet-agnostic signer used by the chain adapter and permit2 helpers.
// Accepts any EIP-1193 provider (browser extension, ledger live,
// WalletConnect, etc.) or a Node-side private-key signer.

import {
    createWalletClient,
    type Hex,
    http,
    keccak256,
    type LocalAccount,
    serializeSignature,
    type TypedDataDomain,
    type TypedDataParameter,
    type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/// Minimal signer the SDK needs from any wallet.
export interface EthSigner {
    /// Chain id pinned at construction so EIP-712 builders don't re-query
    /// the RPC.
    readonly chainId: bigint;
    getAddress(): Promise<string>;
    /// Sign EIP-712 typed-data. Returns 0x-prefixed 65-byte hex.
    signTypedData(
        domain: TypedDataDomain,
        types: Record<string, TypedDataParameter[]>,
        primaryType: string,
        message: Record<string, unknown>,
    ): Promise<string>;
    /// Submit a raw EVM transaction. Returns the broadcast hash.
    sendTransaction(args: {
        to: `0x${string}`;
        data?: `0x${string}`;
        value?: bigint;
    }): Promise<`0x${string}`>;
}

export interface Eip1193ProviderLike {
    request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/// Wraps a raw EIP-1193 provider as `EthSigner` (browser wallets). All
/// signing and broadcast go through `provider.request` so prompts land in
/// the wallet the user connected with.
export class Eip1193Signer implements EthSigner {
    constructor(
        private readonly provider: Eip1193ProviderLike,
        private readonly address: `0x${string}`,
        readonly chainId: bigint,
    ) {}

    getAddress(): Promise<string> {
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
        to: `0x${string}`;
        data?: `0x${string}`;
        value?: bigint;
    }): Promise<`0x${string}`> {
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
        })) as `0x${string}`;
        return hash;
    }
}

/// Local-account signer for Node (tests, scripts, relayer).
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

    async getAddress(): Promise<string> {
        return this.account.address;
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
        to: `0x${string}`;
        data?: `0x${string}`;
        value?: bigint;
    }): Promise<`0x${string}`> {
        const hash = await this.wallet.sendTransaction({
            account: this.account,
            chain: null,
            to: args.to,
            data: args.data,
            value: args.value,
        });
        return hash;
    }
}

function domainTypes(domain: TypedDataDomain) {
    const out: { name: string; type: string }[] = [];
    if (domain.name !== undefined) out.push({ name: "name", type: "string" });
    if (domain.version !== undefined) out.push({ name: "version", type: "string" });
    if (domain.chainId !== undefined) out.push({ name: "chainId", type: "uint256" });
    if (domain.verifyingContract !== undefined) {
        out.push({ name: "verifyingContract", type: "address" });
    }
    if (domain.salt !== undefined) out.push({ name: "salt", type: "bytes32" });
    return out;
}

function serialisableDomain(domain: TypedDataDomain): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (domain.name !== undefined) out.name = domain.name;
    if (domain.version !== undefined) out.version = domain.version;
    if (domain.chainId !== undefined) out.chainId = bigintToHex(BigInt(domain.chainId));
    if (domain.verifyingContract !== undefined) out.verifyingContract = domain.verifyingContract;
    if (domain.salt !== undefined) out.salt = domain.salt;
    return out;
}

function stringifyBigInts(v: unknown): unknown {
    if (typeof v === "bigint") return bigintToHex(v);
    if (Array.isArray(v)) return v.map(stringifyBigInts);
    if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v)) out[k] = stringifyBigInts(val);
        return out;
    }
    return v;
}

function bigintToHex(n: bigint): string {
    const hex = n.toString(16);
    return `0x${hex.length % 2 ? `0${hex}` : hex}`;
}

export function rsvToSignature(r: Hex, s: Hex, v: number): Hex {
    return serializeSignature({ r, s, v: BigInt(v) });
}

/// Re-export viem's keccak256 for callers that want a single import path.
export { keccak256 };
