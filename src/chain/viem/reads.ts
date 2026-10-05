// MASP contract reads.

import { decodeEventLog, getAbiItem } from "viem";
import { type AssetId, branded, type EvmAddress, type Hex32 } from "../../core/brand.js";
import { fieldToBytes32, hexToBytes } from "../../core/hex.js";
import type { Field } from "../../crypto/index.js";
import { assertInvariant } from "../../errors/base.js";
import { WireFormatError } from "../../errors/network.js";
import { RAY } from "../../protocol/units.js";
import { NOTE_PAYLOAD_TOPIC } from "../operation.js";
import type {
    AssetEntry,
    DepositEscrowedRecord,
    EscrowedDepositView,
    PublishedNote,
} from "../types.js";
import { MASP_ABI, YIELD_VENUE_ABI } from "./abi.js";
import type { ViemReadCtx } from "./ctx.js";
import { evmBlockNumber } from "./evm-block.js";
import { heldReceipt } from "./token.js";

/** `bytes32(0)` — what an unset escrow row reads back as. */
const ZERO_WORD = `0x${"0".repeat(64)}` as const;

/** The registry entry without its yield fields; see {@link fetchAssetYield}. */
export async function fetchAsset(
    ctx: ViemReadCtx,
    id: AssetId,
): Promise<Omit<AssetEntry, keyof AssetYield>> {
    // `asset` returns one struct, fee rates included, so no `assetFees` round
    // trip is needed. `isYield` is left out: `fetchAssetYield` answers the same
    // question from the venue binding the flag mirrors.
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
        // `uint48` on chain, which viem decodes to a JS number; the SDK's
        // amount arithmetic is bigint.
        scale: BigInt(scale),
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
 * The asset's yield fields.
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

    // A plain id: `index` is `RAY`, since nothing is outstanding against an
    // unbound venue, and there is no rate because `scale` alone is exact.
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
 * Blocks to look back when the caller names no `fromBlock`: 12h of 12s blocks.
 *
 * Bounded because public RPCs reject `eth_getLogs` over wide ranges. Callers
 * needing a wider range pass an explicit `fromBlock`.
 */
const DEFAULT_LOG_LOOKBACK_BLOCKS = 3_600n;

export async function fetchDepositEscrowed(
    ctx: ViemReadCtx,
    id: bigint,
    fromBlock?: bigint,
): Promise<DepositEscrowedRecord | null> {
    const from = fromBlock ?? (await defaultFromBlock(ctx));

    // The pool's log, including for a native deposit: the adapter escrows
    // through `MASP.depositAuthorized`, so the event and the id are the pool's.
    const logs = await ctx.publicClient.getLogs({
        address: ctx.maspAddress,
        event: getAbiItem({ abi: MASP_ABI, name: "DepositEscrowed" }),
        args: { id },
        fromBlock: from,
        toBlock: "latest",
    });
    if (logs.length === 0) return null;

    // `id` is unique per escrow, so a second log is refused rather than
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
    // Mapped field by field: one renamed or removed in the ABI fails to compile
    // here rather than reading undefined.
    return {
        id: a.id,
        payer: branded<EvmAddress>(a.payer),
        recipient: branded<EvmAddress>(a.recipient),
        publicAssetId: branded<AssetId>(a.publicAssetId),
        publicIn: a.publicIn,
        feeBpsAtSubmit: a.feeBpsAtSubmit,
        inner: branded<Hex32>(a.inner),
        feeIn: a.feeIn,
        feeAssetId: branded<AssetId>(a.feeAssetId),
        feeInner: branded<Hex32>(a.feeInner),
        pulled: a.pulled,
        // Not in the event, and not always the log's block number: the digest
        // hashes `uint32(block.number)` as the EVM saw it; see `evm-block.ts`.
        submittedAt: Number(await evmBlockNumber(ctx.publicClient, blockNumber)),
    };
}

/** Tip minus {@link DEFAULT_LOG_LOOKBACK_BLOCKS}, floored at genesis. */
async function defaultFromBlock(ctx: ViemReadCtx): Promise<bigint> {
    const tip = await ctx.publicClient.getBlockNumber();
    return tip > DEFAULT_LOG_LOOKBACK_BLOCKS ? tip - DEFAULT_LOG_LOOKBACK_BLOCKS : 0n;
}

/**
 * The pool's `NotePayload` for `cm` in transaction `txHash`, or `null` when the
 * transaction has none or the node holds no receipt for `txHash`. The receipt
 * is not waited for; `ReceiptReads.fetchNotePayload` (`../port.ts`) says why.
 *
 * Only a log the pool itself emitted counts: any contract can emit an event of
 * the same shape.
 */
export async function fetchNotePayload(
    ctx: ViemReadCtx,
    txHash: Hex32,
    cm: Hex32,
): Promise<PublishedNote | null> {
    const receipt = await heldReceipt(ctx, txHash);
    if (receipt === null) return null;
    const pool = ctx.maspAddress.toLowerCase();
    const wanted = cm.toLowerCase();
    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== pool) continue;
        if (log.topics[0]?.toLowerCase() !== NOTE_PAYLOAD_TOPIC) continue;
        if (log.topics[1]?.toLowerCase() !== wanted) continue;
        const { args } = decodeEventLog({
            abi: MASP_ABI,
            eventName: "NotePayload",
            data: log.data,
            topics: log.topics,
        });
        return {
            cm: branded<Hex32>(args.cm),
            clueR: [args.clueRx, args.clueRy],
            ephPub: [args.ephPubX, args.ephPubY],
            ciphertext: hexToBytes(args.ciphertext),
        };
    }
    return null;
}
