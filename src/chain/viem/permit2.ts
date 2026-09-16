// Permit2 signing, allowance reads, and the on-chain `permit` call.

import { encodeFunctionData } from "viem";
import { branded, type EvmAddress, type Hex32, type TokenAmount } from "../../core/brand.js";
import { signPermit2Allowance, signPermit2AllowanceBatch } from "../../permit2/allowance.js";
import { signPermit2Witness } from "../../permit2/witness.js";
import type {
    Permit2Sig,
    PermitBatch,
    PermitDetails,
    PermitSingle,
} from "../../protocol/deposit-request.js";
import type { Permit2SignArgs } from "../types.js";
import { PERMIT2_PERMIT_ABI, PERMIT2_PERMIT_BATCH_ABI, PERMIT2_VIEW_ABI } from "./abi.js";
import { addr, hex, type ViemCtx, type ViemReadCtx } from "./ctx.js";
import { sendAndConfirm } from "./token.js";

/** The signer identity every Permit2 signing call needs from the adapter. */
async function signerArgs(ctx: ViemCtx) {
    return {
        signer: ctx.signer,
        chainId: await ctx.chainId(),
        permit2Address: ctx.permit2Address,
    };
}

export async function signPermit2(ctx: ViemCtx, args: Permit2SignArgs): Promise<Permit2Sig> {
    return signPermit2Witness({ ...args, ...(await signerArgs(ctx)), spender: ctx.maspAddress });
}

export async function signAllowance(
    ctx: ViemCtx,
    permit: PermitSingle,
): Promise<{ signature: string }> {
    const { signature } = await signPermit2Allowance({ ...(await signerArgs(ctx)), permit });
    return { signature };
}

/** N-token twin of {@link signAllowance}. */
export async function signAllowanceBatch(
    ctx: ViemCtx,
    permit: PermitBatch,
): Promise<{ signature: string }> {
    const { signature } = await signPermit2AllowanceBatch({ ...(await signerArgs(ctx)), permit });
    return { signature };
}

export async function permit2Allowance(
    ctx: ViemReadCtx,
    token: EvmAddress,
    owner: EvmAddress,
    spender: EvmAddress,
): Promise<{ amount: TokenAmount; expiration: number; nonce: number }> {
    const [amount, expiration, nonce] = await ctx.publicClient.readContract({
        address: ctx.permit2Address,
        abi: PERMIT2_VIEW_ABI,
        functionName: "allowance",
        args: [owner, token, spender],
    });
    return {
        amount: branded<TokenAmount>(amount),
        expiration: Number(expiration),
        nonce: Number(nonce),
    };
}

/** The Permit2 tuple viem's ABI expects for one `PermitDetails`. */
const detailsTuple = (d: PermitDetails) => ({
    token: addr(d.token),
    amount: d.amount,
    expiration: d.expiration,
    nonce: d.nonce,
});

/** Broadcast an encoded Permit2 call and wait for it. Shared by both permits. */
async function sendPermit(
    ctx: ViemCtx,
    data: `0x${string}`,
    onTxHash?: (hash: Hex32) => void,
): Promise<{ txHash: Hex32 }> {
    const to = ctx.permit2Address;
    const { txHash } = await sendAndConfirm(ctx, { to, data }, "permit2.permit", onTxHash);
    return { txHash };
}

export async function permit2PermitAllowance(
    ctx: ViemCtx,
    args: { owner: EvmAddress; permit: PermitSingle; signature: string },
    onTxHash?: (hash: Hex32) => void,
): Promise<{ txHash: Hex32 }> {
    const data = encodeFunctionData({
        abi: PERMIT2_PERMIT_ABI,
        functionName: "permit",
        args: [
            args.owner,
            {
                details: detailsTuple(args.permit.details),
                spender: addr(args.permit.spender),
                sigDeadline: args.permit.sigDeadline,
            },
            hex(args.signature),
        ] as never,
    });
    return sendPermit(ctx, data, onTxHash);
}

/**
 * N-token twin of {@link permit2PermitAllowance}. One tx establishes every
 * window in `permit.details`.
 *
 * Carries the same stale-nonce hazard as the signature it submits; see
 * `signPermit2AllowanceBatch`.
 */
export async function permit2PermitAllowanceBatch(
    ctx: ViemCtx,
    args: { owner: EvmAddress; permit: PermitBatch; signature: string },
    onTxHash?: (hash: Hex32) => void,
): Promise<{ txHash: Hex32 }> {
    const data = encodeFunctionData({
        abi: PERMIT2_PERMIT_BATCH_ABI,
        functionName: "permit",
        args: [
            args.owner,
            {
                details: args.permit.details.map(detailsTuple),
                spender: addr(args.permit.spender),
                sigDeadline: args.permit.sigDeadline,
            },
            hex(args.signature),
        ] as never,
    });
    return sendPermit(ctx, data, onTxHash);
}
