// MASP contract reads.

import { decodeEventLog } from "viem";
import { type AssetId, branded, type EvmAddress, type Hex32 } from "../../core/brand.js";
import { TxMiningError } from "../../core/errors.js";
import type { AssetEntry, DepositEscrowedRecord, EscrowedDepositView } from "../types.js";
import { MASP_ABI } from "./abi.js";
import type { ViemCtx } from "./ctx.js";
import { evmBlockNumber } from "./evm-block.js";

/** `bytes32(0)` — what an unset escrow row reads back as. */
const ZERO_WORD = `0x${"0".repeat(64)}` as const;

export async function fetchAsset(ctx: ViemCtx, id: AssetId): Promise<AssetEntry> {
    // One struct, not three flat returns — viem decodes it to an object.
    const { token, disabled, scale } = await ctx.publicClient.readContract({
        address: ctx.maspAddress,
        abi: MASP_ABI,
        functionName: "asset",
        args: [id],
    });
    return { token: branded<EvmAddress>(token), scale, disabled };
}

export async function fetchFeeBps(ctx: ViemCtx): Promise<bigint> {
    const bps = await ctx.publicClient.readContract({
        address: ctx.maspAddress,
        abi: MASP_ABI,
        functionName: "feeBps",
    });
    return BigInt(bps);
}

export async function getEscrowed(ctx: ViemCtx, id: bigint): Promise<EscrowedDepositView | null> {
    const digest = await ctx.publicClient.readContract({
        address: ctx.maspAddress,
        abi: MASP_ABI,
        functionName: "escrowed",
        args: [id],
    });
    // A cleared or never-written row reads back as the zero word.
    if (digest === ZERO_WORD) return null;
    return { digest: branded<Hex32>(digest) };
}

export async function cancelDelay(ctx: ViemCtx): Promise<number> {
    return await ctx.publicClient.readContract({
        address: ctx.maspAddress,
        abi: MASP_ABI,
        functionName: "cancelDelay",
    });
}

export async function fetchDepositEscrowed(
    ctx: ViemCtx,
    id: bigint,
    fromBlock: bigint = 0n,
): Promise<DepositEscrowedRecord | null> {
    const event = MASP_ABI.find((a) => a.type === "event" && a.name === "DepositEscrowed") as
        | Extract<(typeof MASP_ABI)[number], { type: "event" }>
        | undefined;
    if (!event) throw new TxMiningError("fetchDepositEscrowed: ABI missing DepositEscrowed");

    // Always the pool's log, including for a native deposit: the adapter
    // escrows through `MASP.depositAuthorized`, so the event and the id are
    // the pool's.
    const logs = await ctx.publicClient.getLogs({
        address: ctx.maspAddress,
        event,
        args: { id } as never,
        fromBlock,
        toBlock: "latest",
    });
    if (logs.length === 0) return null;

    const first = logs[0];
    if (!first) return null;
    const decoded = decodeEventLog({
        abi: MASP_ABI,
        data: first.data,
        topics: first.topics,
    });
    if (decoded.eventName !== "DepositEscrowed") return null;

    // The event emits cvDep as two flat scalars; the record carries one point.
    // Keep this mapping explicit — it is the trust boundary between the ABI
    // decode and the domain type. `eventName` above narrows `args`, so a field
    // that moves in the ABI fails here rather than silently reading undefined.
    const a = decoded.args;
    return {
        id: a.id,
        payer: branded<EvmAddress>(a.payer),
        recipient: branded<EvmAddress>(a.recipient),
        publicAssetId: branded<AssetId>(a.publicAssetId),
        publicIn: a.publicIn,
        feeBpsAtSubmit: a.feeBpsAtSubmit,
        cm: branded<Hex32>(a.cm),
        cvDep: [a.cvDepX, a.cvDepY],
        rcv: a.rcv,
        // Not in the event, and NOT simply the log's block number: the digest
        // hashes `uint32(block.number)` as the EVM saw it, which on Arbitrum is
        // the L1 height rather than the L2 height the log reports. Getting this
        // wrong makes `cancelDeposit` revert `DigestMismatch` forever.
        submittedAt: Number(await evmBlockNumber(ctx.publicClient, first.blockNumber)),
    };
}
