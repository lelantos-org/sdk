// viem-based `ChainAdapter`: the signing half, over `ViemChainReader`.
//
// The class is a thin composition over the call modules in this directory:
// reads, token, deposits, permit2. `ViemChainReader` owns the client, the
// addresses and every read; this subclass adds an `EthSigner` and the members
// that sign as the user's EOA or spend its gas.
//
// Inputs arrive via an `EthSigner` (browser EIP-1193 wallet or Node private
// key — see `../signer/`) plus a read RPC URL. A caller with no signing key
// constructs `ViemChainReader` directly and gets a wallet that can spend from
// the pool but not shield into it.

import type { EvmAddress, Hex32, TokenAmount } from "../../core/brand.js";
import type { EthSigner } from "../../core/signer.js";
import type {
    AuxOutput,
    DepositRequest,
    Permit2Sig,
    PermitBatch,
    PermitSingle,
} from "../../protocol/deposit-request.js";
import type { ChainAdapter } from "../port.js";
import type { CancelDepositInputs, Permit2SignArgs } from "../types.js";
import type { ViemCtx } from "./ctx.js";
import * as deposits from "./deposits.js";
import * as permit2 from "./permit2.js";
import { ViemChainReader, type ViemChainReaderOpts } from "./reader.js";
import * as token from "./token.js";

export { MASP_ABI, NATIVE_ADAPTER_ABI } from "./abi.js";
export { ViemChainReader, type ViemChainReaderOpts } from "./reader.js";

export interface ViemChainAdapterOpts extends ViemChainReaderOpts {
    signer: EthSigner;
}

export class ViemChainAdapter extends ViemChainReader implements ChainAdapter {
    readonly signer: EthSigner;
    private readonly ctx: ViemCtx;

    constructor(opts: ViemChainAdapterOpts) {
        super(opts);
        this.signer = opts.signer;
        // The read context plus the key. Spread rather than rebuilt so the
        // two can never drift: every address and the chain-id cache are the
        // ones the reads already use.
        this.ctx = { ...this.readCtx, signer: this.signer };
    }

    payerAddress(): Promise<EvmAddress> {
        return this.signer.getAddress();
    }

    // ── tokens ───────────────────────────────────────────────────────────
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

    // ── permit2 (signing) ────────────────────────────────────────────────
    signPermit2(args: Permit2SignArgs): Promise<Permit2Sig> {
        return permit2.signPermit2(this.ctx, args);
    }
    signPermit2Allowance(permit: PermitSingle): Promise<{ signature: string }> {
        return permit2.signAllowance(this.ctx, permit);
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
}
