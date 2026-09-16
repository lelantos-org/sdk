// Generic ERC-20 and native-token operations, independent of MASP.

import { encodeFunctionData, type Hex } from "viem";
import { branded, type EvmAddress, type Hex32, type TokenAmount } from "../../core/brand.js";
import { safeCall } from "../../core/callbacks.js";
import { TxRevertedError } from "../../errors/chain.js";
import type { TokenMeta, TxLog } from "../types.js";
import { ERC20_ABI, WETH_DEPOSIT_ABI } from "./abi.js";
import { addr, type ViemCtx, type ViemReadCtx } from "./ctx.js";

/** Overall cap on a receipt wait. viem polls forever without one. */
const RECEIPT_TIMEOUT_MS = 300_000;

export async function tokenMeta(ctx: ViemReadCtx, token: EvmAddress): Promise<TokenMeta> {
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
    return { symbol, decimals: Number(decimals) };
}

export async function tokenBalanceOf(
    ctx: ViemReadCtx,
    token: EvmAddress,
    account: EvmAddress,
): Promise<TokenAmount> {
    return branded<TokenAmount>(
        await ctx.publicClient.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [account],
        }),
    );
}

export async function tokenAllowance(
    ctx: ViemReadCtx,
    token: EvmAddress,
    owner: EvmAddress,
    spender: EvmAddress,
): Promise<TokenAmount> {
    return branded<TokenAmount>(
        await ctx.publicClient.readContract({
            address: token,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [owner, spender],
        }),
    );
}

export async function tokenApprove(
    ctx: ViemCtx,
    token: EvmAddress,
    spender: EvmAddress,
    amount: TokenAmount,
    onTxHash?: (hash: Hex32) => void,
): Promise<{ txHash: Hex32 }> {
    const data = encodeFunctionData({
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, amount],
    });
    const { txHash } = await sendAndConfirm(ctx, { to: token, data }, "tokenApprove", onTxHash);
    return { txHash };
}

export async function wrapNative(
    ctx: ViemCtx,
    wethAddr: EvmAddress,
    value: bigint,
): Promise<{ txHash: Hex32 }> {
    const data = encodeFunctionData({ abi: WETH_DEPOSIT_ABI, functionName: "deposit" });
    const { txHash } = await sendAndConfirm(ctx, { to: wethAddr, data, value }, "wrapNative");
    return { txHash };
}

/**
 * The receipt of a transaction this adapter sent, once mined, polled every
 * second under {@link RECEIPT_TIMEOUT_MS}.
 */
function minedReceipt(ctx: ViemReadCtx, txHash: Hex32, confirmations = 1) {
    return ctx.publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations,
        pollingInterval: 1000,
        timeout: RECEIPT_TIMEOUT_MS,
    });
}

export async function waitTxReceipt(
    ctx: ViemReadCtx,
    txHash: Hex32,
    confirmations = 1,
): Promise<{ blockNumber: number; status: number }> {
    const receipt = await minedReceipt(ctx, txHash, confirmations);
    return {
        blockNumber: Number(receipt.blockNumber),
        status: receipt.status === "success" ? 1 : 0,
    };
}

/**
 * Send a transaction from the adapter's signer and wait for it, refusing one that mined and
 * reverted: a status-0 receipt resolves like any other, and an approval, permit or deposit that
 * reverted did nothing.
 *
 * `onSent` gets the hash once broadcast. Guarded (and logged as `callback`): the transaction will
 * still mine, so a throwing callback must not abort the flow and lose its hash.
 *
 * @throws {TxRevertedError} for a reverted transaction, carrying its hash.
 */
export async function sendAndConfirm(
    ctx: ViemCtx,
    tx: { to: EvmAddress; data: Hex; value?: bigint },
    method: string,
    onSent?: ((hash: Hex32) => void) | undefined,
    callback = "onTxHash",
) {
    const txHash = await ctx.signer.sendTransaction(tx);
    safeCall(callback, onSent, txHash);
    const receipt = await minedReceipt(ctx, txHash);
    if (receipt.status !== "success") {
        throw new TxRevertedError(txHash, `${method}: transaction reverted`);
    }
    return { txHash, receipt };
}

/**
 * Cap on waiting for a receipt the relayer has already seen mined.
 *
 * Short, unlike {@link RECEIPT_TIMEOUT_MS}: the relayer answers only after
 * inclusion, so this covers a read RPC a block or two behind it, not a
 * transaction still in the mempool.
 */
const MINED_RECEIPT_TIMEOUT_MS = 15_000;

export async function txReceiptLogs(ctx: ViemReadCtx, txHash: Hex32): Promise<readonly TxLog[]> {
    const receipt = await ctx.publicClient.waitForTransactionReceipt({
        hash: txHash,
        pollingInterval: 1000,
        timeout: MINED_RECEIPT_TIMEOUT_MS,
    });
    return receipt.logs.map((l) => ({
        address: addr(l.address),
        topics: l.topics.map((t) => branded<Hex32>(t)),
    }));
}

export async function nativeBalance(ctx: ViemReadCtx, account: EvmAddress): Promise<bigint> {
    return ctx.publicClient.getBalance({ address: account });
}
