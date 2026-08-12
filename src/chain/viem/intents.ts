// Deposit-intent submission and cancellation.
//
// The three submit paths (witness / native / authorized) each encode their own
// calldata — viem infers the argument tuple from the ABI, so a struct that
// drifts from the contract is a compile error — then share the send/receipt/
// log-extraction tail.

import { encodeFunctionData, type Hex, parseEventLogs } from "viem";
import type { Hex32 } from "../../core/brand.js";
import { safeCall } from "../../core/callbacks.js";
import { TxMiningError } from "../../core/errors.js";
import type { AuxOutput, DepositIntent, Permit2Sig } from "../../protocol/deposit-intent.js";
import type { CancelIntentInputs } from "../types.js";
import { MASP_ABI } from "./abi.js";
import { hex, type ViemCtx } from "./ctx.js";
import { waitTxReceipt } from "./token.js";
import { auxTuple, intentTuple } from "./tuples.js";

export interface SubmitBase {
    intent: DepositIntent;
    aux: AuxOutput;
    onSent?: ((txHash: Hex32) => void) | undefined;
}

export function submitIntent(
    ctx: ViemCtx,
    args: SubmitBase & { permit2: Permit2Sig },
): Promise<{ txHash: Hex32; intentId: bigint }> {
    const data = encodeFunctionData({
        abi: MASP_ABI,
        functionName: "submitIntent",
        args: [
            intentTuple(args.intent),
            {
                nonce: args.permit2.nonce,
                deadline: args.permit2.deadline,
                maxTotal: args.permit2.maxTotal,
                signature: hex(args.permit2.signature),
            },
            auxTuple(args.aux),
        ],
    });
    return sendAndExtractIntentId(ctx, data, args.onSent);
}

export function submitIntentNative(
    ctx: ViemCtx,
    args: SubmitBase & { value: bigint },
): Promise<{ txHash: Hex32; intentId: bigint }> {
    const data = encodeFunctionData({
        abi: MASP_ABI,
        functionName: "submitIntentNative",
        args: [intentTuple(args.intent), auxTuple(args.aux)],
    });
    return sendAndExtractIntentId(ctx, data, args.onSent, args.value);
}

export function submitIntentAuthorized(
    ctx: ViemCtx,
    args: SubmitBase,
): Promise<{ txHash: Hex32; intentId: bigint }> {
    const data = encodeFunctionData({
        abi: MASP_ABI,
        functionName: "submitIntentAuthorized",
        args: [intentTuple(args.intent), auxTuple(args.aux)],
    });
    return sendAndExtractIntentId(ctx, data, args.onSent);
}

async function sendAndExtractIntentId(
    ctx: ViemCtx,
    data: Hex,
    onSent?: (txHash: Hex32) => void,
    value?: bigint,
): Promise<{ txHash: Hex32; intentId: bigint }> {
    const hash = await ctx.signer.sendTransaction({
        to: ctx.maspAddress,
        data,
        ...(value !== undefined ? { value } : {}),
    });
    safeCall("onSent", onSent, hash);

    const receipt = await ctx.publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: 1000,
        timeout: 300_000,
    });
    const events = parseEventLogs({
        abi: MASP_ABI,
        eventName: "IntentEscrowed",
        logs: receipt.logs,
    });
    if (events.length === 0) {
        // Carry the hash: the transaction mined, so the caller needs it to
        // inspect what happened.
        throw new TxMiningError("submitIntent: IntentEscrowed log not found", { txHash: hash });
    }
    return { txHash: hash, intentId: (events[0]!.args as { id: bigint }).id };
}

export async function cancelIntent(
    ctx: ViemCtx,
    id: bigint,
    inputs: CancelIntentInputs,
): Promise<{ txHash: Hex32 }> {
    const data = encodeFunctionData({
        abi: MASP_ABI,
        functionName: "cancelIntent",
        // The contract keeps only `keccak(intent)` per escrow, so the fields
        // it used to read from storage are now supplied by the caller and
        // checked against that digest. They come off the `IntentEscrowed` log.
        args: [
            id,
            // `uint48`, so viem wants a JS number. Lossless: 2^48 is well
            // inside the safe-integer range.
            Number(inputs.publicIn),
            hex(inputs.cm),
            [inputs.cvDep[0], inputs.cvDep[1]],
            inputs.publicAssetId,
            inputs.feeBpsAtSubmit,
            hex(inputs.payer),
            inputs.submittedAt,
        ],
    });
    const hash = await ctx.signer.sendTransaction({ to: ctx.maspAddress, data });
    await waitTxReceipt(ctx, hash);
    return { txHash: hash };
}
