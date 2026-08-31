// viem-based `ChainAdapter`.
//
// The class is a thin composition over the call modules in this directory:
// reads, token, deposits, permit2. It owns exactly the shared state — the
// clients, the two addresses, and the chain-id cache — and delegates
// everything else.
//
// Inputs arrive via an `EthSigner` (browser EIP-1193 wallet or Node private
// key — see `../signer/`) plus a read RPC URL.

import { createPublicClient, http, type PublicClient } from "viem";
import type { AssetId, EvmAddress, Hex32, TokenAmount } from "../../core/brand.js";
import type { EthSigner } from "../../core/signer.js";
import type { Field } from "../../crypto/index.js";
import type {
    AuxOutput,
    DepositRequest,
    Permit2Sig,
    PermitBatch,
    PermitSingle,
} from "../../protocol/deposit-request.js";
import { PERMIT2_ADDRESS } from "../../protocol/deposit-request.js";
import type { ChainAdapter } from "../port.js";
import type {
    AssetEntry,
    CancelDepositInputs,
    DepositEscrowedRecord,
    EscrowedDepositView,
    Permit2SignArgs,
    TokenMeta,
} from "../types.js";
import { addr, type ViemCtx } from "./ctx.js";
import * as deposits from "./deposits.js";
import * as permit2 from "./permit2.js";
import * as reads from "./reads.js";
import * as token from "./token.js";

export { MASP_ABI, NATIVE_ADAPTER_ABI } from "./abi.js";

export interface ViemChainAdapterOpts {
    rpcUrl: string;
    signer: EthSigner;
    maspAddress: string;
    permit2Address?: string | undefined;
    /**
     * `NativeAdapter` deployed alongside the pool. Required for native-coin
     * deposits and unshields: MASP is ERC-20 only, so without it those paths
     * have no entry point and the adapter reports them as unsupported.
     */
    nativeAdapterAddress?: string | undefined;
    chainId?: bigint | undefined;
}

export class ViemChainAdapter implements ChainAdapter {
    readonly publicClient: PublicClient;
    readonly signer: EthSigner;
    private readonly ctx: ViemCtx;
    private readonly _maspAddress: EvmAddress;
    private readonly _permit2Address: EvmAddress;
    private readonly _nativeAdapterAddress?: EvmAddress | undefined;
    private readonly chainIdOverride?: bigint | undefined;
    private cachedChainId?: bigint;

    constructor(opts: ViemChainAdapterOpts) {
        this.publicClient = createPublicClient({ transport: http(opts.rpcUrl) });
        this.signer = opts.signer;
        this._maspAddress = addr(opts.maspAddress);
        this._permit2Address = addr(opts.permit2Address ?? PERMIT2_ADDRESS);
        this._nativeAdapterAddress = opts.nativeAdapterAddress
            ? addr(opts.nativeAdapterAddress)
            : undefined;
        this.chainIdOverride = opts.chainId;

        this.ctx = {
            publicClient: this.publicClient,
            signer: this.signer,
            maspAddress: this._maspAddress,
            permit2Address: this._permit2Address,
            nativeAdapterAddress: this._nativeAdapterAddress,
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

    payerAddress(): Promise<EvmAddress> {
        return this.signer.getAddress();
    }

    async blockNumber(): Promise<number> {
        return Number(await this.publicClient.getBlockNumber());
    }

    fetchAsset(id: AssetId): Promise<AssetEntry> {
        return reads.fetchAsset(this.ctx, id);
    }
    getEscrowed(id: bigint): Promise<EscrowedDepositView | null> {
        return reads.getEscrowed(this.ctx, id);
    }
    fetchDepositEscrowed(id: bigint, fromBlock?: bigint): Promise<DepositEscrowedRecord | null> {
        return reads.fetchDepositEscrowed(this.ctx, id, fromBlock);
    }
    cancelDelay(): Promise<number> {
        return reads.cancelDelay(this.ctx);
    }
    isKnownRoot(root: Field): Promise<boolean> {
        return reads.isKnownRoot(this.ctx, root);
    }

    // ── tokens ───────────────────────────────────────────────────────────
    tokenMeta(a: EvmAddress): Promise<TokenMeta> {
        return token.tokenMeta(this.ctx, a);
    }
    tokenBalanceOf(a: EvmAddress, account: EvmAddress): Promise<TokenAmount> {
        return token.tokenBalanceOf(this.ctx, a, account);
    }
    tokenAllowance(a: EvmAddress, owner: EvmAddress, spender: EvmAddress): Promise<TokenAmount> {
        return token.tokenAllowance(this.ctx, a, owner, spender);
    }
    tokenApprove(
        a: EvmAddress,
        spender: EvmAddress,
        amount: TokenAmount,
        onTxHash?: (hash: Hex32) => void,
    ): Promise<{ txHash: Hex32 }> {
        return token.tokenApprove(this.ctx, a, spender, amount, onTxHash);
    }
    wrapNative(wethAddr: EvmAddress, value: bigint): Promise<{ txHash: Hex32 }> {
        return token.wrapNative(this.ctx, wethAddr, value);
    }
    waitTxReceipt(
        txHash: Hex32,
        confirmations?: number,
    ): Promise<{ blockNumber: number; status: number }> {
        return token.waitTxReceipt(this.ctx, txHash, confirmations);
    }
    nativeBalance(account: EvmAddress): Promise<bigint> {
        return token.nativeBalance(this.ctx, account);
    }

    // ── deposit ──────────────────────────────────────────────────────────
    submitDeposit(args: {
        deposit: DepositRequest;
        permit2: Permit2Sig;
        aux: AuxOutput;
        feeAux: AuxOutput;
        onSent?: ((txHash: Hex32) => void) | undefined;
    }): Promise<{ txHash: Hex32; depositId: bigint }> {
        return deposits.submitDeposit(this.ctx, args);
    }
    submitDepositNative(args: {
        deposit: DepositRequest;
        aux: AuxOutput;
        feeAux: AuxOutput;
        value: bigint;
        onSent?: ((txHash: Hex32) => void) | undefined;
    }): Promise<{ txHash: Hex32; depositId: bigint }> {
        return deposits.submitDepositNative(this.ctx, args);
    }
    submitDepositAuthorized(args: {
        deposit: DepositRequest;
        aux: AuxOutput;
        feeAux: AuxOutput;
        onSent?: ((txHash: Hex32) => void) | undefined;
    }): Promise<{ txHash: Hex32; depositId: bigint }> {
        return deposits.submitDepositAuthorized(this.ctx, args);
    }
    cancelDeposit(id: bigint, inputs: CancelDepositInputs): Promise<{ txHash: Hex32 }> {
        return deposits.cancelDeposit(this.ctx, id, inputs);
    }
    cancelDepositNative(
        id: bigint,
        inputs: Omit<CancelDepositInputs, "payer">,
    ): Promise<{ txHash: Hex32 }> {
        return deposits.cancelDepositNative(this.ctx, id, inputs);
    }

    // ── permit2 ──────────────────────────────────────────────────────────
    signPermit2(args: Permit2SignArgs): Promise<Permit2Sig> {
        return permit2.signPermit2(this.ctx, args);
    }
    signPermit2Allowance(permit: PermitSingle): Promise<{ signature: string }> {
        return permit2.signAllowance(this.ctx, permit);
    }
    permit2Allowance(
        tok: EvmAddress,
        owner: EvmAddress,
        spender: EvmAddress,
    ): Promise<{ amount: TokenAmount; expiration: number; nonce: number }> {
        return permit2.permit2Allowance(this.ctx, tok, owner, spender);
    }
    permit2PermitAllowance(
        args: { owner: EvmAddress; permit: PermitSingle; signature: string },
        onTxHash?: (hash: Hex32) => void,
    ): Promise<{ txHash: Hex32 }> {
        return permit2.permit2PermitAllowance(this.ctx, args, onTxHash);
    }
    signPermit2AllowanceBatch(permit: PermitBatch): Promise<{ signature: string }> {
        return permit2.signAllowanceBatch(this.ctx, permit);
    }
    permit2PermitAllowanceBatch(
        args: { owner: EvmAddress; permit: PermitBatch; signature: string },
        onTxHash?: (hash: Hex32) => void,
    ): Promise<{ txHash: Hex32 }> {
        return permit2.permit2PermitAllowanceBatch(this.ctx, args, onTxHash);
    }
    permit2Nonce(): Promise<bigint> {
        return permit2.permit2Nonce();
    }
    permit2Address(): EvmAddress {
        return this._permit2Address;
    }

    // ── addresses ────────────────────────────────────────────────────────
    async maspAddress(): Promise<EvmAddress> {
        return this._maspAddress;
    }
    /** `undefined` when no `NativeAdapter` is configured for this chain. */
    nativeAdapterAddress(): EvmAddress | undefined {
        return this._nativeAdapterAddress;
    }
}
