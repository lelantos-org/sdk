// Coin-cover helper: encapsulates the "select notes; on insufficient cover
// either consolidate-and-retry or throw" pattern shared by `transfer` and
// `withdraw`.

import { InsufficientCoverError } from "./errors.js";
import type { StoredNote } from "./note-store.js";
import type { CoinSelector, ConsolidateFirst, DirectSelection, SelectOpts } from "./selection.js";

export interface CoverArgs {
    asset: bigint;
    target: bigint;
    selectOpts?: SelectOpts;
    autoConsolidate?: boolean;
}

export async function ensureCover(
    selector: CoinSelector,
    notes: () => StoredNote[],
    args: CoverArgs,
    consolidate: (asset: bigint, sel: ConsolidateFirst) => Promise<void>,
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
