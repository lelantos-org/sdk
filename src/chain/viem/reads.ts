// MASP contract reads.

import { decodeEventLog, zeroAddress } from "viem";
import { TxMiningError } from "../../core/errors.js";
import type { AssetEntry, EscrowedIntentView, IntentEscrowedRecord } from "../types.js";
import { MASP_ABI } from "./abi.js";
import type { ViemCtx } from "./ctx.js";

export async function fetchAsset(ctx: ViemCtx, id: bigint): Promise<AssetEntry> {
    const [token, disabled, scale] = (await ctx.publicClient.readContract({
        address: ctx.maspAddress,
        abi: MASP_ABI,
        functionName: "asset",
        args: [id],
    })) as [string, boolean, bigint];
    return { token, scale, disabled };
}

export async function fetchFeeBps(ctx: ViemCtx): Promise<bigint> {
    const bps = (await ctx.publicClient.readContract({
        address: ctx.maspAddress,
        abi: MASP_ABI,
        functionName: "feeBps",
    })) as number;
    return BigInt(bps);
}

export async function getEscrowed(ctx: ViemCtx, id: bigint): Promise<EscrowedIntentView | null> {
    const r = (await ctx.publicClient.readContract({
        address: ctx.maspAddress,
        abi: MASP_ABI,
        functionName: "escrowed",
        args: [id],
    })) as readonly [string, string, number, bigint, number];
    const [digest, payer, submittedAt, publicAssetId, feeBpsAtSubmit] = r;
    if (payer === zeroAddress) return null;
    return {
        digest,
        payer,
        submittedAt: Number(submittedAt),
        publicAssetId,
        feeBpsAtSubmit: Number(feeBpsAtSubmit),
    };
}

export async function cancelDelay(ctx: ViemCtx): Promise<number> {
    const r = (await ctx.publicClient.readContract({
        address: ctx.maspAddress,
        abi: MASP_ABI,
        functionName: "cancelDelay",
    })) as number;
    return Number(r);
}

export async function fetchIntentEscrowed(
    ctx: ViemCtx,
    id: bigint,
    fromBlock: bigint = 0n,
): Promise<IntentEscrowedRecord | null> {
    const event = MASP_ABI.find((a) => a.type === "event" && a.name === "IntentEscrowed") as
        | Extract<(typeof MASP_ABI)[number], { type: "event" }>
        | undefined;
    if (!event) throw new TxMiningError("fetchIntentEscrowed: ABI missing IntentEscrowed");

    const logs = await ctx.publicClient.getLogs({
        address: ctx.maspAddress,
        event,
        args: { id } as never,
        fromBlock,
        toBlock: "latest",
    });
    if (logs.length === 0) return null;

    const decoded = decodeEventLog({
        abi: MASP_ABI,
        data: logs[0].data,
        topics: logs[0].topics,
    });
    if (decoded.eventName !== "IntentEscrowed") return null;

    // The event emits cvDep as four flat scalars; the record carries two
    // points. Keep this mapping explicit — it is the trust boundary between
    // the ABI decode and the domain type.
    const a = decoded.args as unknown as Record<string, bigint | string>;
    return {
        id: a.id as bigint,
        payer: a.payer as string,
        recipient: a.recipient as string,
        publicAssetId: a.publicAssetId as bigint,
        publicIn: a.publicIn as bigint,
        feeBpsAtSubmit: Number(a.feeBpsAtSubmit as bigint),
        cm0: a.cm0 as string,
        cm1: a.cm1 as string,
        cvDep0: [a.cvDep0X as bigint, a.cvDep0Y as bigint],
        cvDep1: [a.cvDep1X as bigint, a.cvDep1Y as bigint],
        rcvTotal: a.rcvTotal as bigint,
    };
}
