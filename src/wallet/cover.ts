// Coin-cover helper shared by `transfer` and `withdraw`: select notes,
// consolidate-and-retry or throw on insufficient cover.

import type { AssetId, CircuitAmount } from "../core/brand.js";
import { InsufficientCoverError } from "../core/errors.js";
import type { StoredNote } from "./note-store.js";
import type { CoinSelector, ConsolidateFirst, DirectSelection, SelectOpts } from "./selection.js";

export interface CoverArgs {
    asset: AssetId;
    target: CircuitAmount;
    selectOpts?: SelectOpts | undefined;
    autoConsolidate?: boolean | undefined;
}

export async function ensureCover(
    selector: CoinSelector,
    notes: () => readonly StoredNote[],
    args: CoverArgs,
    consolidate: (asset: AssetId, sel: ConsolidateFirst) => Promise<void>,
): Promise<DirectSelection> {
    const sel = selector.select(notes(), args.asset, args.target, args.selectOpts);
    if (sel.plan === "direct") return sel;

    if (!args.autoConsolidate) {
        throw new InsufficientCoverError({
            target: args.target,
            asset: args.asset,
            consolidate: sel.consolidate,
            consolidateSum: sel.consolidateSum,
        });
    }
    await consolidate(args.asset, sel);
    const retry = selector.select(notes(), args.asset, args.target, args.selectOpts);
    if (retry.plan === "consolidate-first") {
        throw new InsufficientCoverError({
            target: args.target,
            asset: args.asset,
            consolidate: retry.consolidate,
            consolidateSum: retry.consolidateSum,
        });
    }
    return retry;
}
