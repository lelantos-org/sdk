// Generic ERC-20 and native-token operations, independent of MASP.

import { encodeFunctionData, type Hex } from "viem";
import { branded, type EvmAddress, type Hex32, type TokenAmount } from "../../core/brand.js";
import { safeCall } from "../../core/callbacks.js";
import { TxRevertedError } from "../../errors/chain.js";
import type { TokenMeta, TxLog } from "../types.js";
import { ERC20_ABI, WETH_DEPOSIT_ABI } from "./abi.js";
import { addr, type ViemCtx, type ViemReadCtx } from "./ctx.js";
import { isReceiptNotFound } from "./errors.js";

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

// Receipts. Three reads, chosen by what the caller knows about the hash:
//
//   minedReceipt    the transaction may be pending          `waitTxReceipt`, `sendAndConfirm`
//   recentReceipt   the relayer has seen it mined            `txReceiptLogs`
//   heldReceipt     nothing: the hash was handed in as is    `fetchNotePayload` (`reads.ts`)
//
// The first two wait and reject with viem's receipt timeout, which `chainError` reports as
// `TxMiningError`. The third never waits and resolves `null` for a hash the node has no receipt of.

/** Cap on waiting for a transaction to mine. */
const RECEIPT_TIMEOUT_MS = 300_000;

/**
 * Cap on waiting for a receipt the relayer has already seen mined. The relayer answers only after
 * inclusion, so this covers a read RPC a block or two behind it, not a transaction in the mempool.
 */
const RECENT_RECEIPT_TIMEOUT_MS = 15_000;

/** The receipt of `txHash`, polled for every second until `timeout` ms have passed. */
function awaitReceipt(ctx: ViemReadCtx, txHash: Hex32, timeout: number, confirmations = 1) {
    return ctx.publicClient.waitForTransactionReceipt({
        hash: txHash,
        confirmations,
        pollingInterval: 1000,
        timeout,
    });
}

function minedReceipt(ctx: ViemReadCtx, txHash: Hex32, confirmations = 1) {
    return awaitReceipt(ctx, txHash, RECEIPT_TIMEOUT_MS, confirmations);
}

function recentReceipt(ctx: ViemReadCtx, txHash: Hex32) {
    return awaitReceipt(ctx, txHash, RECENT_RECEIPT_TIMEOUT_MS);
}

/** `null` for a hash the node does not know, or a transaction not yet mined. */
export async function heldReceipt(ctx: ViemReadCtx, txHash: Hex32) {
    try {
        return await ctx.publicClient.getTransactionReceipt({ hash: txHash });
    } catch (err) {
        if (isReceiptNotFound(err)) return null;
        throw err;
    }
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

/** The logs of a transaction the relayer reported mined, in receipt order. */
export async function txReceiptLogs(ctx: ViemReadCtx, txHash: Hex32): Promise<readonly TxLog[]> {
    const receipt = await recentReceipt(ctx, txHash);
    return receipt.logs.map((l) => ({
        address: addr(l.address),
        topics: l.topics.map((t) => branded<Hex32>(t)),
    }));
}

export async function nativeBalance(ctx: ViemReadCtx, account: EvmAddress): Promise<bigint> {
    return ctx.publicClient.getBalance({ address: account });
}
