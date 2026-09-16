// viem-based `ChainAdapter`: the signing half, over `ViemChainReader`.
//
// The class composes the call modules in this directory: reads, token,
// deposits, permit2. `ViemChainReader` owns the client, the addresses and every
// read; this subclass adds an `EthSigner` and the members that sign as the
// user's EOA or spend its gas.
//
// Inputs are an `EthSigner` (browser EIP-1193 wallet or Node private key; see
// `../signer/`) plus a read RPC URL. A caller without a signing key constructs `ViemChainReader`
// directly and gets a wallet that can spend from the pool but not shield into it.

import type { EvmAddress, Hex32, TokenAmount } from "../../core/brand.js";
import type { EthSigner } from "../../keys/signer.js";
import type {
    AuxOutput,
    DepositRequest,
    Permit2Sig,
    PermitBatch,
    PermitSingle,
} from "../../protocol/deposit-request.js";
import type { ChainAdapter } from "../port.js";
import type {
    CancelDepositInputs,
    CancelDepositReceipt,
    DepositSubmitted,
    Permit2SignArgs,
} from "../types.js";
import type { ViemCtx } from "./ctx.js";
import * as deposits from "./deposits.js";
import { chainCall } from "./errors.js";
import * as permit2 from "./permit2.js";
import { ViemChainReader, type ViemChainReaderOpts } from "./reader.js";
import * as token from "./token.js";

export { ViemChainReader } from "./reader.js";

export interface ViemChainAdapterOpts extends ViemChainReaderOpts {
    signer: EthSigner;
}

export class ViemChainAdapter extends ViemChainReader implements ChainAdapter {
    readonly signer: EthSigner;
    private readonly ctx: ViemCtx;

    constructor(opts: ViemChainAdapterOpts) {
        super(opts);
        this.signer = opts.signer;
        // Spread rather than rebuilt so every address and the chain-id cache
        // are shared with the reads.
        this.ctx = { ...this.readCtx, signer: this.signer };
    }

    payerAddress(): Promise<EvmAddress> {
        return chainCall("payerAddress", () => this.signer.getAddress());
    }

    // ── tokens ───────────────────────────────────────────────────────────
    tokenApprove(
        a: EvmAddress,
        spender: EvmAddress,
        amount: TokenAmount,
        onTxHash?: (hash: Hex32) => void,
    ): Promise<{ txHash: Hex32 }> {
        return chainCall("tokenApprove", () =>
            token.tokenApprove(this.ctx, a, spender, amount, onTxHash),
        );
    }
    wrapNative(wethAddr: EvmAddress, value: bigint): Promise<{ txHash: Hex32 }> {
        return chainCall("wrapNative", () => token.wrapNative(this.ctx, wethAddr, value));
    }

    // ── deposit ──────────────────────────────────────────────────────────
    submitDeposit(args: {
        deposit: DepositRequest;
        permit2: Permit2Sig;
        aux: AuxOutput;
        feeAux: AuxOutput;
        onSent?: ((txHash: Hex32) => void) | undefined;
    }): Promise<DepositSubmitted> {
        return chainCall("submitDeposit", () => deposits.submitDeposit(this.ctx, args));
    }
    submitDepositNative(args: {
        deposit: DepositRequest;
        aux: AuxOutput;
        feeAux: AuxOutput;
        value: bigint;
        onSent?: ((txHash: Hex32) => void) | undefined;
    }): Promise<DepositSubmitted> {
        return chainCall("submitDepositNative", () => deposits.submitDepositNative(this.ctx, args));
    }
    submitDepositAuthorized(args: {
        deposit: DepositRequest;
        aux: AuxOutput;
        feeAux: AuxOutput;
        onSent?: ((txHash: Hex32) => void) | undefined;
    }): Promise<DepositSubmitted> {
        return chainCall("submitDepositAuthorized", () =>
            deposits.submitDepositAuthorized(this.ctx, args),
        );
    }
    cancelDeposit(id: bigint, inputs: CancelDepositInputs): Promise<CancelDepositReceipt> {
        return chainCall("cancelDeposit", () => deposits.cancelDeposit(this.ctx, id, inputs));
    }
    cancelDepositNative(
        id: bigint,
        inputs: Omit<CancelDepositInputs, "payer">,
    ): Promise<CancelDepositReceipt> {
        return chainCall("cancelDepositNative", () =>
            deposits.cancelDepositNative(this.ctx, id, inputs),
        );
    }

    // ── permit2 (signing) ────────────────────────────────────────────────
    signPermit2(args: Permit2SignArgs): Promise<Permit2Sig> {
        return chainCall("signPermit2", () => permit2.signPermit2(this.ctx, args), "sign-permit");
    }
    signPermit2Allowance(permit: PermitSingle): Promise<{ signature: string }> {
        return chainCall(
            "signPermit2Allowance",
            () => permit2.signAllowance(this.ctx, permit),
            "sign-permit",
        );
    }
    permit2PermitAllowance(
        args: { owner: EvmAddress; permit: PermitSingle; signature: string },
        onTxHash?: (hash: Hex32) => void,
    ): Promise<{ txHash: Hex32 }> {
        return chainCall("permit2PermitAllowance", () =>
            permit2.permit2PermitAllowance(this.ctx, args, onTxHash),
        );
    }
    signPermit2AllowanceBatch(permit: PermitBatch): Promise<{ signature: string }> {
        return chainCall(
            "signPermit2AllowanceBatch",
            () => permit2.signAllowanceBatch(this.ctx, permit),
            "sign-permit",
        );
    }
    permit2PermitAllowanceBatch(
        args: { owner: EvmAddress; permit: PermitBatch; signature: string },
        onTxHash?: (hash: Hex32) => void,
    ): Promise<{ txHash: Hex32 }> {
        return chainCall("permit2PermitAllowanceBatch", () =>
            permit2.permit2PermitAllowanceBatch(this.ctx, args, onTxHash),
        );
    }
}
