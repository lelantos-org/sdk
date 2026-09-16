// A swap's amounts, computed by `quoteSwap` and recomputed, by the same functions, by `swap`.
//
// Leg 1 unshields `gross` of `assetIn` to `SwapWrapper`; what the pool delivers after its withdraw
// fee (`withdrawNet`, index- and yield-correct) is the venue's `amountIn`. Leg 2 escrows either the
// output note, sized so its pull covers `minOut`, or the refund note, sized to what leg 1
// delivered. Each escrow also carries its own flush fee note.

import {
    type AssetId,
    type CircuitAmount,
    type EvmAddress,
    evmAddress,
    type TokenAmount,
} from "../../core/brand.js";
import { UnsupportedOperationError } from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { sizeBNote, sizeRefundNote, type YieldPricing } from "../../protocol/swap-sizing.js";
import {
    chargedMoney,
    publicMoney,
    type ResolvedOutAmount,
    resolveOutAmount,
    shieldedMoney,
} from "../assets/amount.js";
import type { AssetRef } from "../assets/asset-ref.js";
import type { AssetInfo } from "../assets/info.js";
import type { WalletContext } from "../context.js";
import type { SwapFees, SwapQuote } from "../types/quotes.js";
import type { Money } from "../types/results.js";
import { type DepositFee, depositProtocolFee, resolveDepositFees } from "./deposit-fee.js";

/** A quote's fields `swap` reads, checked for shape. A quote is plain data a UI may have cloned. */
export interface CheckedQuote {
    assetIn: { id: AssetId };
    assetOut: { id: AssetId };
    fees?: unknown;
    side: "gross" | "net";
    gross: { amount: bigint };
    net: { baseUnits: TokenAmount };
    credit: { amount: bigint };
    refundCredit: { amount: bigint };
    minOut: TokenAmount;
    /** The allowlisted adapter and its encoded path. */
    route: SwapQuote["route"];
}

/** Both legs' note values and flush fees. */
export interface SwapLegs {
    /** Leg 1: `gross` units of `assetIn`; `net` base units reach the venue; `fee` to the pool. */
    readonly out: ResolvedOutAmount;
    /** The output note, in `assetOut`. */
    readonly credit: CircuitAmount;
    /** The refund note, in `assetIn`. */
    readonly refundCredit: CircuitAmount;
    readonly outputFee: DepositFee;
    readonly refundFee: DepositFee;
}

/** Both assets, chain-verified, refused when they are one asset named two ways. */
export async function resolveSwapAssets(
    ctx: Pick<WalletContext, "assets">,
    assetIn: AssetRef,
    assetOut: AssetRef,
): Promise<[AssetInfo, AssetInfo]> {
    // Verified: both tokens are bound into the intent hash and both scales and rates size the
    // escrow pulls, so they come from the pool, never the relayer's list.
    const a = await ctx.assets.resolveVerified(assetIn);
    const b = await ctx.assets.resolveVerified(assetOut);
    // Compared as resolved ids: `"WETH"` and `1n` may name the same asset.
    if (a.id === b.id) {
        throw new InvalidArgumentError("swap: assetIn must differ from assetOut", {
            argument: "assetOut",
        });
    }
    return [a, b];
}

/** `SwapWrapper`: the preset's, else the relayer's advertised one. */
export async function resolveSwapWrapper(
    ctx: Pick<WalletContext, "cfg" | "relayerInfo">,
    op: string,
): Promise<EvmAddress> {
    const raw = ctx.cfg.swapWrapperAddress ?? (await ctx.relayerInfo.swapWrapperAddress());
    if (!raw) {
        throw new UnsupportedOperationError(op, [
            "a SwapWrapper address (`swapWrapperAddress` in the network preset, or the relayer's /chains)",
        ]);
    }
    return evmAddress(raw);
}

/**
 * Size both escrow notes for leg 1's `out` and the venue floor `minOut`.
 *
 * Each note pays its flush fee in its own asset: the wrapper holds only the escrowed token, and
 * `MaspEscrowSatellite` reverts `FeeAssetMismatch` for a valued note in any other.
 */
export async function swapLegs(
    ctx: Pick<WalletContext, "J" | "cfg" | "address">,
    assetIn: AssetInfo,
    assetOut: AssetInfo,
    out: ResolvedOutAmount,
    minOut: bigint,
): Promise<SwapLegs> {
    const [outputFee, refundFee] = (await resolveDepositFees(ctx, [assetOut.id, assetIn.id])) as [
        DepositFee,
        DepositFee,
    ];
    // A yield output note is priced as the pool prices the deposit: units at `gross / supply`.
    const credit = sizeBNote(
        minOut,
        assetOut.scale,
        assetOut.depositBps,
        outputFee.value,
        yieldPricing(assetOut),
    );
    if (credit <= 0n) {
        throw new InvalidArgumentError(
            `swap: minOut ${minOut} is below one unit of the output asset after its fees (zero output note)`,
            { argument: "minOut" },
        );
    }
    const refundCredit = sizeRefundNote(
        out.net,
        assetIn.scale,
        assetIn.depositBps,
        refundFee.value,
        yieldPricing(assetIn),
    );
    if (refundCredit <= 0n) {
        throw new InvalidArgumentError(
            `swap: leg 1 delivers ${out.net}, too little to refund after fees (zero refund note)`,
            { argument: out.side },
        );
    }
    return {
        out,
        credit: credit as CircuitAmount,
        refundCredit: refundCredit as CircuitAmount,
        outputFee,
        refundFee,
    };
}

/** A swap's charges; `null` for each that is not charged. */
export function swapFees(
    assetIn: AssetInfo,
    assetOut: AssetInfo,
    legs: SwapLegs,
    relayer: Money | null,
): SwapFees {
    return Object.freeze({
        protocol: chargedMoney(publicMoney(assetIn, legs.out.fee)),
        relayer,
        flush: chargedMoney(shieldedMoney(assetOut, legs.outputFee.value)),
        // Leg 2 mints the output note as a deposit, charged on top of it inside the pull.
        outProtocol: depositProtocolFee(assetOut, legs.credit),
    });
}

/** The rate a yield asset's deposit is priced at; nothing for a plain asset. */
function yieldPricing(asset: AssetInfo): YieldPricing {
    return asset.yieldEnabled ? { yieldEnabled: true, rate: asset.rate } : {};
}

/**
 * Why a quote could not have come from `quoteSwap` over its own asset snapshots: the first figure
 * its own `assetIn` / `assetOut` / `fees.flush` do not reproduce, or `undefined` when it is
 * internally consistent. Also refuses snapshots whose token, scale or yield mode differ from the
 * pool's now, which no rate movement explains.
 *
 * Tells a tampered quote (`INVALID_ARGUMENT`) from one that went stale because an index or the
 * relayer's flush fee moved (`QUOTE_STALE`). The refund note is bounded rather than reproduced:
 * its flush fee is not part of the quote.
 */
export function quoteInconsistency(
    quote: CheckedQuote,
    now: { assetIn: AssetInfo; assetOut: AssetInfo },
): string | undefined {
    const snapIn = snapshot(quote.assetIn, now.assetIn);
    if (typeof snapIn === "string") return `assetIn${snapIn}`;
    const snapOut = snapshot(quote.assetOut, now.assetOut);
    if (typeof snapOut === "string") return `assetOut${snapOut}`;
    try {
        const out = resolveOutAmount(
            quote.side === "gross"
                ? { gross: quote.gross.amount as CircuitAmount }
                : { net: { baseUnits: quote.net.baseUnits } },
            snapIn,
            "swap",
        );
        if (out.gross !== quote.gross.amount) return "gross";
        if (out.net !== quote.net.baseUnits) return "net";
        const flush = (quote.fees as { flush?: { amount?: unknown } | null } | undefined)?.flush;
        const flushValue = flush == null ? 0n : flush.amount;
        if (typeof flushValue !== "bigint" || flushValue < 0n) return "fees.flush";
        const credit = sizeBNote(
            quote.minOut,
            snapOut.scale,
            snapOut.depositBps,
            flushValue,
            yieldPricing(snapOut),
        );
        if (credit !== quote.credit.amount) return "credit";
        const refundCeiling = sizeRefundNote(
            out.net,
            snapIn.scale,
            snapIn.depositBps,
            0n,
            yieldPricing(snapIn),
        );
        const refund = quote.refundCredit.amount;
        if (refund <= 0n || refund > refundCeiling) return "refundCredit";
    } catch {
        return "quote";
    }
    return undefined;
}

/** A quote's asset snapshot, checked for shape and for what rates cannot change; else the field. */
function snapshot(v: unknown, current: AssetInfo): AssetInfo | string {
    const a = v as Partial<AssetInfo> | null;
    if (
        typeof a !== "object" ||
        a === null ||
        typeof a.scale !== "bigint" ||
        typeof a.depositBps !== "bigint" ||
        typeof a.withdrawBps !== "bigint" ||
        typeof a.token !== "string" ||
        (a.index !== undefined && typeof a.index !== "bigint")
    ) {
        return "";
    }
    if (a.token.toLowerCase() !== current.token.toLowerCase()) return ".token";
    if (a.scale !== current.scale) return ".scale";
    if ((a.yieldEnabled === true) !== (current.yieldEnabled === true)) return ".yieldEnabled";
    return { ...current, ...a, yieldEnabled: a.yieldEnabled === true } as AssetInfo;
}
