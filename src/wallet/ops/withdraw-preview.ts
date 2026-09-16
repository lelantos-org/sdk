// What a withdrawal will publish, cost and deliver, computed before proving.
//
//   1. `WithdrawOptions.gross` is the GROSS. The contract deducts the protocol fee from what
//      leaves the pool, so the recipient receives less than the amount passed in.
//   2. The gross is published on-chain, so the gross (not the net) must be a ladder denomination
//      for the withdrawal to blend with others.

import { branded, type CircuitAmount, circuitAmount, type TokenAmount } from "../../core/brand.js";
import type { Ladder } from "../../protocol/denominations.js";
import { formatUnits } from "../../protocol/units.js";
import type { Amount } from "../assets/amount.js";
import { formatAmount, resolveAmount } from "../assets/amount.js";
import {
    type AssetInfo,
    isOnLadder,
    nearestDenomination,
    requireTokenMeta,
    withdrawNetFor,
} from "../assets/index.js";

/** Input to {@link previewWithdraw}. */
export interface WithdrawPreviewArgs {
    /** The gross leaving the pool; the value passed as `WithdrawOptions.gross`. */
    amount: Amount;
    /**
     * Carries its own `withdrawBps`, so the preview is pure and needs no network round trip.
     */
    asset: AssetInfo;
}

/** Result of {@link previewWithdraw}. */
export interface WithdrawPreview {
    /** The gross leaving the pool, in circuit units; the value published on-chain. */
    publicOut: CircuitAmount;
    /** ERC-20 base units reaching the recipient. */
    net: TokenAmount;
    /** ERC-20 base units the protocol keeps. `net + fee` is the gross. */
    fee: TokenAmount;
    /** {@link WithdrawPreview.net} as a human decimal string. */
    netFormatted: string;
    /**
     * Whether `publicOut` is one of the asset's denominations.
     *
     * `false` is not rejected, but an off-ladder `publicOut` is a near-unique public integer that
     * makes the withdrawal linkable to the deposit that funded it. Callers should surface it.
     */
    onLadder: boolean;
    /**
     * Whether the asset has a ladder; `false` only when the wallet opted out via
     * `WalletConfig.denominations`, in which case `onLadder` is always `false` and meaningless.
     */
    hasLadder: boolean;
    /** The asset's denominations, ascending. Empty when it has none. */
    denominations: Ladder;
    /** Closest denomination, when the amount is off-ladder and one exists. */
    suggestion?: CircuitAmount;
}

/**
 * Preview a withdrawal without proving or submitting anything.
 *
 * ```ts
 * const p = previewWithdraw({ amount: "1000", asset: usdc });
 * p.publicOut;    // 1_000_000_000n, published on-chain
 * p.netFormatted; // "998", received by the recipient
 * p.onLadder;     // true
 * ```
 *
 * Pure. `wallet.previewWithdraw` is the bound form that resolves the asset.
 */
export function previewWithdraw(args: WithdrawPreviewArgs): WithdrawPreview {
    const { asset } = args;
    const meta = requireTokenMeta(asset);
    const publicOut = resolveAmount(args.amount, asset);
    const { net, fee } = withdrawNetFor(publicOut, asset);

    const onLadder = isOnLadder(publicOut, asset);
    const suggestion = onLadder ? undefined : nearestDenomination(publicOut, asset);

    return {
        publicOut,
        net: branded<TokenAmount>(net),
        fee: branded<TokenAmount>(fee),
        netFormatted: formatUnits(net, meta.decimals),
        onLadder,
        hasLadder: asset.ladder.length > 0,
        denominations: asset.ladder,
        ...(suggestion !== undefined ? { suggestion } : {}),
    };
}

/** One denomination, with the human labels a picker shows for it. */
export interface DenominationChoice {
    /** Pass this as `WithdrawOptions.gross`. */
    value: CircuitAmount;
    /** Current worth of the denomination, e.g. `"1000"`. */
    label: string;
    /** Amount the recipient would receive, e.g. `"998"`. */
    netLabel: string;
}

/**
 * The asset's denominations, labelled for a picker. Empty when it has none.
 *
 * Both labels change with the yield index while `value` stays fixed, so recompute on index
 * changes rather than caching the strings.
 */
export function denominationChoices(asset: AssetInfo): DenominationChoice[] {
    const meta = requireTokenMeta(asset);
    return asset.ladder.map((d) => {
        const value = circuitAmount(d);
        return {
            value,
            label: formatAmount(value, asset),
            netLabel: formatUnits(withdrawNetFor(value, asset).net, meta.decimals),
        };
    });
}
