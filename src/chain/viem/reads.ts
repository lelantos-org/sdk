// MASP contract reads.

import { decodeEventLog } from "viem";
import { type AssetId, branded, type EvmAddress, type Hex32 } from "../../core/brand.js";
import { TxMiningError } from "../../core/errors.js";
import { fieldToBytes32 } from "../../core/hex.js";
import { RAY } from "../../core/units.js";
import type { Field } from "../../crypto/index.js";
import type { AssetEntry, DepositEscrowedRecord, EscrowedDepositView } from "../types.js";
import { MASP_ABI, YIELD_VENUE_ABI } from "./abi.js";
import type { ViemCtx } from "./ctx.js";
import { evmBlockNumber } from "./evm-block.js";

/** `bytes32(0)` — what an unset escrow row reads back as. */
const ZERO_WORD = `0x${"0".repeat(64)}` as const;

export async function fetchAsset(ctx: ViemCtx, id: AssetId): Promise<AssetEntry> {
    // One struct, not five flat returns — viem decodes it to an object.
    //
    // The two fee rates come back with the entry rather than from a second
    // `assetFees(id)` call: they are read on every deposit and every withdraw,
    // and the pool already returns them here, so asking twice is a round trip
    // that buys nothing. `assetFees` stays in the ABI for callers that want
    // the rates without the rest of the entry.
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
export type AssetYield = Pick<AssetEntry, "index" | "yieldEnabled" | "rate">;

/** `address(0)` — what `yieldState.venue` reads back as for a plain asset. */
const ZERO_ADDRESS = `0x${"0".repeat(40)}` as const;

/**
 * `yieldState(id)`, or `undefined` when the pool has no such selector.
 *
 * The revert is load-bearing rather than an error to report: a pool deployed
 * before the mixin cannot answer this at all, and every asset on it is a plain
 * one — which is what makes the read backwards compatible. It is not
 * distinguishable from an RPC failure, and deliberately so: the alternative is
 * failing `fetchAsset` outright on a pool where nothing yields.
 *
 * Split from its caller so the catch covers exactly this probe. Reading the
 * *venue* afterwards is a call to a contract the pool just named, and a failure
 * there is a real fault that must not read as "no yield".
 */
async function readYieldState(ctx: ViemCtx, id: AssetId) {
    try {
        return await ctx.publicClient.readContract({
            address: ctx.maspAddress,
            abi: MASP_ABI,
            functionName: "yieldState",
            args: [id],
        });
    } catch {
        return undefined;
    }
}

/**
 * The asset's yield fields, or `undefined` when the pool has no yield mixin.
 *
 * Two calls at most, and the second only for an id that actually yields:
 * `yieldState` answers both "does this id yield" — `venue` is zero when it does
 * not — and, for one that does, everything except the venue's own position.
 */
export async function fetchAssetYield(ctx: ViemCtx, id: AssetId): Promise<AssetYield | undefined> {
    const state = await readYieldState(ctx, id);
    if (!state) return undefined;

    // A plain id on a pool that does have the mixin. `index` is `RAY` here by
    // construction — nothing is outstanding against a venue that is not bound —
    // and there is no rate, because `scale` alone is already exact.
    if (state.venue === ZERO_ADDRESS) return { index: RAY, yieldEnabled: false };

    const lent = await ctx.publicClient.readContract({
        address: branded<EvmAddress>(state.venue),
        abi: YIELD_VENUE_ABI,
        functionName: "totalAssets",
    });

    return {
        index: state.index,
        yieldEnabled: true,
        // `gross` is the venue position plus what the pool is holding back;
        // `supply` is every normalized unit written against it, the depositors'
        // and the accrued performance fee's alike. Skimming the fee out of
        // `supply` would price the rest above what the pool will actually pay.
        rate: {
            gross: lent + state.idle,
            supply: state.totalNormalized + state.accruedFeeNormalized,
        },
    };
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

/** Whether the pool would accept a proof against `root`. */
export async function isKnownRoot(ctx: ViemCtx, root: Field): Promise<boolean> {
    return await ctx.publicClient.readContract({
        address: ctx.maspAddress,
        abi: MASP_ABI,
        functionName: "isKnownRoot",
        args: [fieldToBytes32(root)],
    });
}

export async function cancelDelay(ctx: ViemCtx): Promise<number> {
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
    ctx: ViemCtx,
    id: bigint,
    fromBlock?: bigint,
): Promise<DepositEscrowedRecord | null> {
    const event = MASP_ABI.find((a) => a.type === "event" && a.name === "DepositEscrowed") as
        | Extract<(typeof MASP_ABI)[number], { type: "event" }>
        | undefined;
    if (!event) throw new TxMiningError("fetchDepositEscrowed: ABI missing DepositEscrowed");

    const from = fromBlock ?? (await defaultFromBlock(ctx));

    // Always the pool's log, including for a native deposit: the adapter
    // escrows through `MASP.depositAuthorized`, so the event and the id are
    // the pool's.
    const logs = await ctx.publicClient.getLogs({
        address: ctx.maspAddress,
        event,
        args: { id } as never,
        fromBlock: from,
        toBlock: "latest",
    });
    if (logs.length === 0) return null;

    // `id` is unique per escrow, so more than one log means the chain state
    // does not match what this function assumes. Reporting it beats silently
    // decoding whichever arrived first.
    if (logs.length > 1) {
        throw new TxMiningError(
            `fetchDepositEscrowed: ${logs.length} DepositEscrowed logs for id ${id}; ` +
                "expected at most one",
        );
    }

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

/** Tip minus {@link DEFAULT_LOG_LOOKBACK_BLOCKS}, floored at genesis. */
async function defaultFromBlock(ctx: ViemCtx): Promise<bigint> {
    const tip = await ctx.publicClient.getBlockNumber();
    return tip > DEFAULT_LOG_LOOKBACK_BLOCKS ? tip - DEFAULT_LOG_LOOKBACK_BLOCKS : 0n;
}
