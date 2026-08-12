// Deposit-intent submission and cancellation.
//
// The three submit paths (witness / native / authorized) share one call,
// parameterised by function name, argument tuple, and whether ETH rides along.

import { encodeFunctionData, type Hex, parseEventLogs } from "viem";
import type { Hex32 } from "../../core/brand.js";
import { safeCall } from "../../core/callbacks.js";
import { TxMiningError } from "../../core/errors.js";
import type { AuxOutput, DepositIntent, Permit2Sig } from "../../protocol/deposit-intent.js";
import type { CancelIntentInputs } from "../types.js";
import { MASP_ABI } from "./abi.js";
import { hex, type ViemCtx } from "./ctx.js";
import { waitTxReceipt } from "./token.js";
import { auxTuples, intentTuple } from "./tuples.js";

type SubmitFn = "submitIntent" | "submitIntentNative" | "submitIntentAuthorized";

export interface SubmitBase {
    intent: DepositIntent;
    aux: [AuxOutput, AuxOutput];
    onSent?: ((txHash: Hex32) => void) | undefined;
}

export function submitIntent(
    ctx: ViemCtx,
    args: SubmitBase & { permit2: Permit2Sig },
): Promise<{ txHash: Hex32; intentId: bigint }> {
    return submitVia(ctx, "submitIntent", args.onSent, [
        intentTuple(args.intent),
        {
            nonce: args.permit2.nonce,
            deadline: args.permit2.deadline,
            maxTotal: args.permit2.maxTotal,
            signature: hex(args.permit2.signature),
        },
        auxTuples(args.aux),
    ]);
}

export function submitIntentNative(
    ctx: ViemCtx,
    args: SubmitBase & { value: bigint },
): Promise<{ txHash: Hex32; intentId: bigint }> {
    return submitVia(
        ctx,
        "submitIntentNative",
        args.onSent,
        [intentTuple(args.intent), auxTuples(args.aux)],
        args.value,
    );
}

export function submitIntentAuthorized(
    ctx: ViemCtx,
    args: SubmitBase,
): Promise<{ txHash: Hex32; intentId: bigint }> {
    return submitVia(ctx, "submitIntentAuthorized", args.onSent, [
        intentTuple(args.intent),
        auxTuples(args.aux),
    ]);
}

async function submitVia(
    ctx: ViemCtx,
    functionName: SubmitFn,
    onSent: ((txHash: Hex32) => void) | undefined,
    args: unknown[],
    value?: bigint,
): Promise<{ txHash: Hex32; intentId: bigint }> {
    // `as never`: viem cannot infer the tuple shape through the domain
    // structs. The encoding is pinned by `encoding-parity.test.ts`.
    const data = encodeFunctionData({ abi: MASP_ABI, functionName, args: args as never });
    return sendAndExtractIntentId(ctx, data, onSent, value);
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
        args: [
            id,
            inputs.publicIn,
            hex(inputs.cm0),
            hex(inputs.cm1),
            [inputs.cvDep0[0], inputs.cvDep0[1]],
            [inputs.cvDep1[0], inputs.cvDep1[1]],
        ] as never,
    });
    const hash = await ctx.signer.sendTransaction({ to: ctx.maspAddress, data });
    await waitTxReceipt(ctx, hash);
    return { txHash: hash };
}
