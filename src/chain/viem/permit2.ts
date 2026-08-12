// Permit2 signing, allowance reads, and the on-chain `permit` call.

import { encodeFunctionData } from "viem";
import { branded, type EvmAddress, type Hex32, type TokenAmount } from "../../core/brand.js";
import { safeCall } from "../../core/callbacks.js";
import { randomU256 } from "../../core/random.js";
import { signPermit2Allowance, signPermit2Witness } from "../../permit2/sign.js";
import type { Permit2Sig, PermitSingle } from "../../protocol/deposit-intent.js";
import type { Permit2SignArgs } from "../types.js";
import { PERMIT2_PERMIT_ABI, PERMIT2_VIEW_ABI } from "./abi.js";
import { addr, hex, type ViemCtx } from "./ctx.js";
import { waitTxReceipt } from "./token.js";

export async function signPermit2(ctx: ViemCtx, args: Permit2SignArgs): Promise<Permit2Sig> {
    return signPermit2Witness({
        signer: ctx.signer,
        chainId: await ctx.chainId(),
        spender: ctx.maspAddress,
        token: args.token,
        maxTotal: args.maxTotal,
        nonce: args.nonce,
        deadline: args.deadline,
        piHash: args.piHash,
        permit2Address: ctx.permit2Address,
    });
}

export async function signAllowance(
    ctx: ViemCtx,
    permit: PermitSingle,
): Promise<{ signature: string }> {
    const r = await signPermit2Allowance({
        signer: ctx.signer,
        chainId: await ctx.chainId(),
        permit,
        permit2Address: ctx.permit2Address,
    });
    return { signature: r.signature };
}

export async function permit2Allowance(
    ctx: ViemCtx,
    token: EvmAddress,
    owner: EvmAddress,
    spender: EvmAddress,
): Promise<{ amount: TokenAmount; expiration: number; nonce: number }> {
    const r = (await ctx.publicClient.readContract({
        address: ctx.permit2Address,
        abi: PERMIT2_VIEW_ABI,
        functionName: "allowance",
        args: [owner, token, spender],
    })) as readonly [bigint, number, number];
    return {
        amount: branded<TokenAmount>(r[0]),
        expiration: Number(r[1]),
        nonce: Number(r[2]),
    };
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
                details: {
                    token: addr(args.permit.details.token),
                    amount: args.permit.details.amount,
                    expiration: args.permit.details.expiration,
                    nonce: args.permit.details.nonce,
                },
                spender: addr(args.permit.spender),
                sigDeadline: args.permit.sigDeadline,
            },
            hex(args.signature),
        ] as never,
    });
    const hash = await ctx.signer.sendTransaction({ to: ctx.permit2Address, data });
    // Guarded: the permit tx is already broadcast at this point.
    safeCall("onTxHash", onTxHash, hash);
    await waitTxReceipt(ctx, hash);
    return { txHash: hash };
}

/** Permit2 nonces are caller-chosen and unordered; a random u256 is fine. */
export async function permit2Nonce(): Promise<bigint> {
    return randomU256();
}
