// What a relay will cost, before committing to one.
//
// Without this the only way to learn a relayer's price is to build the spend
// and read the exception — which means a UI cannot show the choice it is
// asking the user to make, and a caller cannot check they can afford the fee
// before spending a minute proving.

import type { AssetId, CircuitAmount } from "../core/brand.js";
import { assetId, branded } from "../core/brand.js";
import type { AssetInfo } from "./assets.js";
import type { SpendContext } from "./context.js";
import type { EstimateKind } from "./submitter.js";

/** One asset a relayer will take, and whether this wallet could pay in it. */
export interface FeeOption {
    asset: AssetInfo;
    /** What the fee costs in this asset, in circuit units. */
    amount: CircuitAmount;
    /** Unspent balance held in this asset. */
    balance: CircuitAmount;
    /**
     * Whether `balance` covers `amount`.
     *
     * A necessary condition, not a sufficient one: the notes also have to fit
     * the circuit's input slots, which only coin selection can decide.
     */
    affordable: boolean;
}

/** What relaying `kind` costs, and what it can be paid in. */
export interface FeeQuoteResult {
    /** Empty when the relayer charges nothing on this chain. */
    options: FeeOption[];
    /** The relayer's shielded address, when it is charging. */
    payTo?: string | undefined;
    /**
     * Whether a fee is required at all. `false` means every spend of this kind
     * relays for free, and `feeAsset` is moot.
     */
    charged: boolean;
}

export interface QuoteFeeArgs {
    /** Which operation to price. Swaps are quoted on their own endpoint. */
    kind: EstimateKind;
}

/**
 * Price a relay and list what it may be paid in.
 *
 * Balances come from the wallet's own notes, so `affordable` answers "could I
 * pay this today" rather than merely "would the relayer accept it".
 *
 * An asset the relayer quotes but this SDK cannot resolve is dropped rather
 * than reported: it cannot be paid in, because building the note needs the
 * registry entry.
 */
export async function quoteFee(
    ctx: Pick<SpendContext, "cfg" | "submitter" | "resolveAsset"> & {
        balances(): Map<AssetId, CircuitAmount>;
    },
    args: QuoteFeeArgs,
): Promise<FeeQuoteResult> {
    if (!ctx.submitter.estimate) return { options: [], charged: false };

    const estimate = await ctx.submitter.estimate(ctx.cfg.chainId, args.kind);
    if (estimate.shieldedFeeAddress === undefined) return { options: [], charged: false };

    const held = ctx.balances();
    const options: FeeOption[] = [];
    for (const quote of estimate.fees) {
        if (quote.assetId === undefined || quote.circuitAmount === undefined) continue;
        const id = assetId(BigInt(quote.assetId));
        let asset: AssetInfo;
        try {
            asset = await ctx.resolveAsset(id);
        } catch {
            // Quoted but unresolvable: no registry entry, so no note could be
            // built for it either.
            continue;
        }
        const amount = branded<CircuitAmount>(BigInt(quote.circuitAmount));
        const balance = held.get(id) ?? branded<CircuitAmount>(0n);
        options.push({ asset, amount, balance, affordable: balance >= amount });
    }

    return { options, payTo: estimate.shieldedFeeAddress, charged: true };
}
