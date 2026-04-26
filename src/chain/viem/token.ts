// Generic ERC-20 and native-token operations. Nothing MASP-specific — this
// is the part of the adapter that would work against any pool.

import { encodeFunctionData } from "viem";
import { safeCall } from "../../core/callbacks.js";
import type { TokenMeta } from "../types.js";
import { ERC20_ABI, WETH_DEPOSIT_ABI } from "./abi.js";
import { addr, type ViemCtx } from "./ctx.js";

/** Overall cap on a receipt wait. viem polls forever without one. */
const RECEIPT_TIMEOUT_MS = 300_000;

export async function tokenMeta(ctx: ViemCtx, token: string): Promise<TokenMeta> {
    const [symbol, decimals] = await Promise.all([
        ctx.publicClient.readContract({
            address: addr(token),
            abi: ERC20_ABI,
            functionName: "symbol",
        }),
        ctx.publicClient.readContract({
            address: addr(token),
            abi: ERC20_ABI,
            functionName: "decimals",
        }),
    ]);
    return { symbol: symbol as string, decimals: Number(decimals) };
}

export async function tokenBalanceOf(
    ctx: ViemCtx,
    token: string,
    account: string,
): Promise<bigint> {
    return (await ctx.publicClient.readContract({
        address: addr(token),
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [addr(account)],
    })) as bigint;
}

export async function tokenAllowance(
    ctx: ViemCtx,
    token: string,
    owner: string,
    spender: string,
): Promise<bigint> {
    return (await ctx.publicClient.readContract({
        address: addr(token),
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [addr(owner), addr(spender)],
    })) as bigint;
}

export async function tokenApprove(
    ctx: ViemCtx,
    token: string,
    spender: string,
    amount: bigint,
    onTxHash?: (hash: string) => void,
): Promise<{ txHash: string }> {
    const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [addr(spender), amount],
    });
    const hash = await ctx.signer.sendTransaction({ to: addr(token), data });
    // Guarded: the tx is already broadcast, so a throwing callback here used
    // to abort the flow and lose the hash of a tx that will still mine.
    safeCall("onTxHash", onTxHash, hash);
    await waitTxReceipt(ctx, hash);
    return { txHash: hash };
}

export async function wrapNative(
    ctx: ViemCtx,
    wethAddr: string,
    value: bigint,
): Promise<{ txHash: string }> {
    const data = encodeFunctionData({ abi: WETH_DEPOSIT_ABI, functionName: "deposit" });
    const hash = await ctx.signer.sendTransaction({ to: addr(wethAddr), data, value });
    await waitTxReceipt(ctx, hash);
    return { txHash: hash };
}

export async function waitTxReceipt(
    ctx: ViemCtx,
    txHash: string,
    confirmations = 1,
): Promise<{ blockNumber: number; status: number }> {
    const receipt = await ctx.publicClient.waitForTransactionReceipt({
        hash: addr(txHash),
        confirmations,
        pollingInterval: 1000,
        timeout: RECEIPT_TIMEOUT_MS,
    });
    return {
        blockNumber: Number(receipt.blockNumber),
        status: receipt.status === "success" ? 1 : 0,
    };
}

export async function nativeBalance(ctx: ViemCtx, account: string): Promise<bigint> {
    return ctx.publicClient.getBalance({ address: addr(account) });
}
