// Relay fee quotes, available before building a spend, so a UI can present fee options and a caller
// can check affordability before proving. Backs `wallet.quoteFee`.

import type { CircuitAmount } from "../../core/brand.js";
import { assetId, branded, shieldedAddress } from "../../core/brand.js";
import { toBaseUnits } from "../assets/amount.js";
import type { AssetInfo } from "../assets/info.js";
import { isUnknownAsset } from "../assets/registry.js";
import type { WalletContext } from "../context.js";
import { balancesOf } from "../notes/read-ops.js";
import { relayerEstimate } from "../relayer-info.js";
import { estimateKindOf } from "../tx/fee.js";
import type { FeeKind, FeeOption, FeeQuote } from "../types/quotes.js";

/**
 * Price a relay of `kind` and list what it may be paid in.
 *
 * Balances come from the wallet's notes, so `affordable` reflects whether this wallet can currently
 * pay, not only whether the relayer accepts the asset; both are `undefined` for a deposit, whose
 * fee is funded publicly. `native` prices a withdrawal's native-unwrap estimate.
 *
 * An asset the relayer quotes but the SDK cannot resolve is omitted, since building the fee note
 * requires its registry entry.
 */
export async function quoteFee(
    ctx: Pick<WalletContext, "cfg" | "assets" | "notes">,
    kind: FeeKind,
    opts: { native?: boolean | undefined } = {},
): Promise<FeeQuote> {
    const estimate = await relayerEstimate(ctx, estimateKindOf(kind, "quoteFee", opts.native));
    if (estimate?.shieldedFeeAddress === undefined) {
        return Object.freeze({ kind, charged: false, options: [] });
    }

    const deposit = kind === "deposit";
    const held = balancesOf(ctx.notes.notes);
    const options: FeeOption[] = [];
    for (const quote of estimate.fees) {
        if (quote.assetId === undefined || quote.circuitAmount === undefined) continue;
        const id = assetId(BigInt(quote.assetId));
        let asset: AssetInfo;
        try {
            // Verified: a caller formats `amount` with these decimals and pays with this id.
            asset = await ctx.assets.resolveVerified(id);
        } catch (err) {
            // No registry entry, so no fee note can be built for this asset. Any other failure
            // (an RPC timeout) would silently drop a payable option, so it propagates.
            if (!isUnknownAsset(err)) throw err;
            continue;
        }
        const amount = branded<CircuitAmount>(BigInt(quote.circuitAmount));
        const balance = deposit ? undefined : (held.get(id) ?? branded<CircuitAmount>(0n));
        options.push(
            Object.freeze({
                asset,
                amount,
                baseUnits: toBaseUnits(amount, asset),
                balance,
                affordable: balance === undefined ? undefined : balance >= amount,
            }),
        );
    }

    return Object.freeze({
        kind,
        charged: true,
        payTo: shieldedAddress(estimate.shieldedFeeAddress),
        options,
    });
}
