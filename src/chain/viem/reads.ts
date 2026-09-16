// MASP contract reads.

import { decodeEventLog, getAbiItem } from "viem";
import { type AssetId, branded, type EvmAddress, type Hex32 } from "../../core/brand.js";
import { fieldToBytes32 } from "../../core/hex.js";
import type { Field } from "../../crypto/index.js";
import { assertInvariant } from "../../errors/base.js";
import { WireFormatError } from "../../errors/network.js";
import { RAY } from "../../protocol/units.js";
import type { AssetEntry, DepositEscrowedRecord, EscrowedDepositView } from "../types.js";
import { MASP_ABI, YIELD_VENUE_ABI } from "./abi.js";
import type { ViemReadCtx } from "./ctx.js";
import { evmBlockNumber } from "./evm-block.js";

/** `bytes32(0)` — what an unset escrow row reads back as. */
const ZERO_WORD = `0x${"0".repeat(64)}` as const;

/** The registry entry without its yield fields; see {@link fetchAssetYield}. */
export async function fetchAsset(
    ctx: ViemReadCtx,
    id: AssetId,
): Promise<Omit<AssetEntry, keyof AssetYield>> {
    // One struct, not five flat returns; viem decodes it to an object.
    //
    // The two fee rates come back with the entry rather than from a separate
    // `assetFees(id)` call: they are read on every deposit and withdraw, and a
    // second call would add a round trip. `assetFees` stays in the ABI for
    // callers that want the rates without the rest of the entry.
    const { token, disabled, depositBps, withdrawBps, scale } = await ctx.publicClient.readContract(
        {
            address: ctx.maspAddress,
            abi: MASP_ABI,
            functionName: "asset",
            args: [id],
        },
    );
    return {
        token: branded<EvmAddress>(token),
        scale,
        disabled,
        depositBps: BigInt(depositBps),
        withdrawBps: BigInt(withdrawBps),
    };
}

/** The yield half of an {@link AssetEntry}, read off the pool's mixin. */
type AssetYield = Pick<AssetEntry, "index" | "yieldEnabled" | "rate">;

/** `address(0)` — what `yieldState.venue` reads back as for a plain asset. */
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as const;

/**
 * The asset's yield fields, read off the pool's yield mixin.
 *
 * Two calls at most, the second only for an id that yields: `yieldState`
 * answers whether the id yields (`venue` is zero when it does not) and, if it
 * does, everything except the venue's own position.
 */
export async function fetchAssetYield(ctx: ViemReadCtx, id: AssetId): Promise<AssetYield> {
    const state = await ctx.publicClient.readContract({
        address: ctx.maspAddress,
        abi: MASP_ABI,
        functionName: "yieldState",
        args: [id],
    });

    // A plain id. `index` is `RAY` by construction, since nothing is
    // outstanding against an unbound venue, and there is no rate because
    // `scale` alone is exact.
    if (state.venue === ZERO_ADDRESS) return { index: RAY, yieldEnabled: false };

    const lent = await ctx.publicClient.readContract({
        address: branded<EvmAddress>(state.venue),
        abi: YIELD_VENUE_ABI,
        functionName: "totalAssets",
    });

    return {
        index: state.index,
        yieldEnabled: true,
        // `gross` is the venue position plus the pool's idle balance; `supply`
        // is every normalized unit written against it, the depositors' and the
        // accrued performance fee's alike. Excluding the fee from `supply`
        // would price the rest above what the pool pays.
        rate: {
            gross: lent + state.idle,
            supply: state.totalNormalized + state.accruedFeeNormalized,
        },
    };
}

export async function getEscrowed(
    ctx: ViemReadCtx,
    id: bigint,
): Promise<EscrowedDepositView | null> {
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

/** Whether the pool would accept a proof against `root`. */
export async function isKnownRoot(ctx: ViemReadCtx, root: Field): Promise<boolean> {
    return await ctx.publicClient.readContract({
        address: ctx.maspAddress,
        abi: MASP_ABI,
        functionName: "isKnownRoot",
        args: [fieldToBytes32(root)],
    });
}

export async function cancelDelay(ctx: ViemReadCtx): Promise<number> {
    return await ctx.publicClient.readContract({
        address: ctx.maspAddress,
        abi: MASP_ABI,
        functionName: "cancelDelay",
    });
}

/**
 * Blocks to look back when the caller names no `fromBlock`.
 *
 * Bounded because public RPCs reject `eth_getLogs` spanning more than a few
 * thousand blocks. ~12h at 12s blocks, which covers the cancel window this
 * lookup serves. Callers needing a wider range pass an explicit `fromBlock`.
 */
const DEFAULT_LOG_LOOKBACK_BLOCKS = 3_600n;

export async function fetchDepositEscrowed(
    ctx: ViemReadCtx,
    id: bigint,
    fromBlock?: bigint,
): Promise<DepositEscrowedRecord | null> {
    const from = fromBlock ?? (await defaultFromBlock(ctx));

    // Always the pool's log, including for a native deposit: the adapter
    // escrows through `MASP.depositAuthorized`, so the event and the id are
    // the pool's.
    const logs = await ctx.publicClient.getLogs({
        address: ctx.maspAddress,
        event: getAbiItem({ abi: MASP_ABI, name: "DepositEscrowed" }),
        args: { id },
        fromBlock: from,
        toBlock: "latest",
    });
    if (logs.length === 0) return null;

    // `id` is unique per escrow, so more than one log means the chain state
    // does not match this function's assumptions. Throwing avoids silently
    // decoding whichever arrived first.
    if (logs.length > 1) {
        throw new WireFormatError(
            "$.logs",
            `fetchDepositEscrowed: ${logs.length} DepositEscrowed logs for one id; expected at most one`,
        );
    }

    const log = logs[0]!;
    const { args } = decodeEventLog({
        abi: MASP_ABI,
        eventName: "DepositEscrowed",
        data: log.data,
        topics: log.topics,
    });
    return depositEscrowedRecord(ctx, args, log.blockNumber);
}

/** The decoded `DepositEscrowed` arguments, as viem types them. */
type DepositEscrowedArgs = Extract<
    ReturnType<typeof decodeEventLog<typeof MASP_ABI>>,
    { eventName: "DepositEscrowed" }
>["args"];

/**
 * A `DepositEscrowed` log's arguments as the SDK's record, `submittedAt` resolved for the log's
 * block. Shared by the log query and the deposit receipt, so both yield identical cancel inputs.
 */
export async function depositEscrowedRecord(
    ctx: ViemReadCtx,
    a: DepositEscrowedArgs,
    blockNumber: bigint | null,
): Promise<DepositEscrowedRecord> {
    assertInvariant(blockNumber !== null, "DepositEscrowed log without a block number");
    // The event emits cvDep as two flat scalars; the record carries one point.
    // The mapping is explicit because it is the trust boundary between the ABI
    // decode and the domain type. A field that moves in the ABI fails to compile
    // here rather than silently reading undefined.
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
        feeIn: a.feeIn,
        feeAssetId: branded<AssetId>(a.feeAssetId),
        feeCm: branded<Hex32>(a.feeCm),
        feeCvDep: [a.feeCvDepX, a.feeCvDepY],
        // Not in the event, and NOT always the log's block number: the digest
        // hashes `uint32(block.number)` as the EVM saw it, which on Arbitrum is
        // the L1 height rather than the L2 height the log reports. A wrong
        // value makes `cancelDeposit` revert `DigestMismatch` permanently.
        submittedAt: Number(await evmBlockNumber(ctx.publicClient, blockNumber)),
    };
}

/** Tip minus {@link DEFAULT_LOG_LOOKBACK_BLOCKS}, floored at genesis. */
async function defaultFromBlock(ctx: ViemReadCtx): Promise<bigint> {
    const tip = await ctx.publicClient.getBlockNumber();
    return tip > DEFAULT_LOG_LOOKBACK_BLOCKS ? tip - DEFAULT_LOG_LOOKBACK_BLOCKS : 0n;
}
