// What a withdrawal will publish, cost and deliver — answered before proving.
//
// Two facts are invisible from the call site, and both bite:
//
//   1. `WithdrawOptions.amount` is the GROSS. The contract skims the protocol
//      fee out of what leaves the pool rather than charging it on top, so the
//      recipient always receives less than the number passed in.
//   2. The gross is the figure published on chain, so it — not the net — is
//      what has to be a ladder denomination for the withdrawal to blend with
//      anyone else's.
//
// This module makes both visible in one call rather than three lookups and a
// formula.

import { branded, type CircuitAmount, circuitAmount, type TokenAmount } from "../core/brand.js";
import type { Ladder } from "../core/denominations.js";
import { formatUnits } from "../core/units.js";
import { type AmountLike, resolveAmount } from "./amount.js";
import {
    type AssetInfo,
    formatAmount,
    isOnLadder,
    nearestDenomination,
    requireTokenMeta,
    withdrawNetFor,
} from "./assets.js";

/** Input to {@link previewWithdraw}. */
export interface WithdrawPreviewArgs {
    /** The gross leaving the pool — what `WithdrawOptions.amount` will be. */
    amount: AmountLike;
    /**
     * Carries its own `withdrawBps`, so this stays pure and a UI can call it on
     * every keystroke without a round trip.
     */
    asset: AssetInfo;
}

/** What {@link previewWithdraw} answers. */
export interface WithdrawPreview {
    /** The gross leaving the pool, in circuit units — the value published on chain. */
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
     * `false` is not an error and nothing rejects it — but an off-ladder
     * `publicOut` is a near-unique public integer, so the withdrawal is
     * linkable to whatever deposit funded it in a way an on-ladder one is not.
     * Surface it; do not silently swallow it.
     */
    onLadder: boolean;
    /**
     * Whether the asset has a ladder at all — `false` when no ladder is defined
     * for the token, or when the wallet opted out via
     * `WalletConfig.denominations`. `onLadder` is always `false` when this is,
     * and means nothing in that case.
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
 * p.publicOut;    // 1_000_000_000n — what the chain sees
 * p.netFormatted; // "998" — what the recipient gets
 * p.onLadder;     // true
 * ```
 *
 * Pure. `wallet.previewWithdraw` is the bound form that resolves the asset for
 * you.
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
    /** Pass this as `WithdrawOptions.amount`. */
    value: CircuitAmount;
    /** What the denomination is worth right now, e.g. `"1000"`. */
    label: string;
    /** What the recipient would receive, e.g. `"998"`. */
    netLabel: string;
}

/**
 * The asset's denominations, labelled for a picker. Empty when it has none.
 *
 * Both labels move as the yield index does — a denomination is worth more
 * underlying than it used to be — while `value` never changes. Recompute on
 * index changes rather than caching the strings.
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
