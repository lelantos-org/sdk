// viem-based `ChainAdapter`.
//
// The class is a thin composition over the call modules in this directory:
// reads, token, intents, permit2. It owns exactly the shared state — the
// clients, the two addresses, and the chain-id cache — and delegates
// everything else.
//
// Inputs arrive via an `EthSigner` (browser EIP-1193 wallet or Node private
// key — see `../signer/`) plus a read RPC URL.

import { createPublicClient, http, type PublicClient } from "viem";
import type { EthSigner } from "../../core/signer.js";
import type {
    AuxOutput,
    DepositIntent,
    Permit2Sig,
    PermitSingle,
} from "../../protocol/deposit-intent.js";
import { PERMIT2_ADDRESS } from "../../protocol/deposit-intent.js";
import type { ChainAdapter } from "../port.js";
import type {
    AssetEntry,
    CancelIntentInputs,
    EscrowedIntentView,
    IntentEscrowedRecord,
    Permit2SignArgs,
    TokenMeta,
} from "../types.js";
import { addr, type ViemCtx } from "./ctx.js";
import * as intents from "./intents.js";
import * as permit2 from "./permit2.js";
import * as reads from "./reads.js";
import * as token from "./token.js";

export { MASP_ABI } from "./abi.js";

export interface ViemChainAdapterOpts {
    rpcUrl: string;
    signer: EthSigner;
    maspAddress: string;
    permit2Address?: string;
    chainId?: bigint;
}

export class ViemChainAdapter implements ChainAdapter {
    readonly publicClient: PublicClient;
    readonly signer: EthSigner;
    private readonly ctx: ViemCtx;
    private readonly _maspAddress: `0x${string}`;
    private readonly _permit2Address: `0x${string}`;
    private readonly chainIdOverride?: bigint;
    private cachedChainId?: bigint;

    constructor(opts: ViemChainAdapterOpts) {
        this.publicClient = createPublicClient({ transport: http(opts.rpcUrl) });
        this.signer = opts.signer;
        this._maspAddress = addr(opts.maspAddress);
        this._permit2Address = addr(opts.permit2Address ?? PERMIT2_ADDRESS);
        this.chainIdOverride = opts.chainId;

        this.ctx = {
            publicClient: this.publicClient,
            signer: this.signer,
            maspAddress: this._maspAddress,
            permit2Address: this._permit2Address,
            chainId: () => this.chainId(),
        };
    }

    // ── reads ────────────────────────────────────────────────────────────
    async chainId(): Promise<bigint> {
        if (this.chainIdOverride !== undefined) return this.chainIdOverride;
        if (this.cachedChainId !== undefined) return this.cachedChainId;
        this.cachedChainId = BigInt(await this.publicClient.getChainId());
        return this.cachedChainId;
    }

    payerAddress(): Promise<string> {
        return this.signer.getAddress();
    }

    fetchAsset(id: bigint): Promise<AssetEntry> {
        return reads.fetchAsset(this.ctx, id);
    }
    fetchFeeBps(): Promise<bigint> {
        return reads.fetchFeeBps(this.ctx);
    }
    getEscrowed(id: bigint): Promise<EscrowedIntentView | null> {
        return reads.getEscrowed(this.ctx, id);
    }
    fetchIntentEscrowed(id: bigint, fromBlock?: bigint): Promise<IntentEscrowedRecord | null> {
        return reads.fetchIntentEscrowed(this.ctx, id, fromBlock);
    }
    cancelDelay(): Promise<number> {
        return reads.cancelDelay(this.ctx);
    }

    // ── tokens ───────────────────────────────────────────────────────────
    tokenMeta(a: string): Promise<TokenMeta> {
        return token.tokenMeta(this.ctx, a);
    }
    tokenBalanceOf(a: string, account: string): Promise<bigint> {
        return token.tokenBalanceOf(this.ctx, a, account);
    }
    tokenAllowance(a: string, owner: string, spender: string): Promise<bigint> {
        return token.tokenAllowance(this.ctx, a, owner, spender);
    }
    tokenApprove(
        a: string,
        spender: string,
        amount: bigint,
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }> {
        return token.tokenApprove(this.ctx, a, spender, amount, onTxHash);
    }
    wrapNative(wethAddr: string, value: bigint): Promise<{ txHash: string }> {
        return token.wrapNative(this.ctx, wethAddr, value);
    }
    waitTxReceipt(
        txHash: string,
        confirmations?: number,
    ): Promise<{ blockNumber: number; status: number }> {
        return token.waitTxReceipt(this.ctx, txHash, confirmations);
    }
    nativeBalance(account: string): Promise<bigint> {
        return token.nativeBalance(this.ctx, account);
    }

    // ── deposit ──────────────────────────────────────────────────────────
    submitIntent(args: {
        intent: DepositIntent;
        permit2: Permit2Sig;
        aux: [AuxOutput, AuxOutput];
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }> {
        return intents.submitIntent(this.ctx, args);
    }
    submitIntentNative(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        value: bigint;
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }> {
        return intents.submitIntentNative(this.ctx, args);
    }
    submitIntentAuthorized(args: {
        intent: DepositIntent;
        aux: [AuxOutput, AuxOutput];
        onSent?: (txHash: string) => void;
    }): Promise<{ txHash: string; intentId: bigint }> {
        return intents.submitIntentAuthorized(this.ctx, args);
    }
    cancelIntent(id: bigint, inputs: CancelIntentInputs): Promise<{ txHash: string }> {
        return intents.cancelIntent(this.ctx, id, inputs);
    }

    // ── permit2 ──────────────────────────────────────────────────────────
    signPermit2(args: Permit2SignArgs): Promise<Permit2Sig> {
        return permit2.signPermit2(this.ctx, args);
    }
    signPermit2Allowance(permit: PermitSingle): Promise<{ signature: string }> {
        return permit2.signAllowance(this.ctx, permit);
    }
    permit2Allowance(
        tok: string,
        owner: string,
        spender: string,
    ): Promise<{ amount: bigint; expiration: number; nonce: number }> {
        return permit2.permit2Allowance(this.ctx, tok, owner, spender);
    }
    permit2PermitAllowance(
        args: { owner: string; permit: PermitSingle; signature: string },
        onTxHash?: (hash: string) => void,
    ): Promise<{ txHash: string }> {
        return permit2.permit2PermitAllowance(this.ctx, args, onTxHash);
    }
    permit2Nonce(): Promise<bigint> {
        return permit2.permit2Nonce();
    }
    permit2Address(): string {
        return this._permit2Address;
    }

    // ── addresses ────────────────────────────────────────────────────────
    async maspAddress(): Promise<string> {
        return this._maspAddress;
    }
}
