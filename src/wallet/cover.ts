// Coin-cover helper shared by `transfer` and `withdraw`: select notes,
// consolidate-and-retry or throw on insufficient cover.
//
// One thing here is less obvious than it looks: **options are re-read per
// attempt, not captured once.** `selectOpts` carries `tipBlock`, and the
// cooldown rule is `tip - firstSeenBlock < cooldownBlocks`. Consolidation
// creates a note in a block at or after the tip the first attempt saw, so a
// retry reusing that captured tip excludes the very note it just made —
// deterministically, not as a race. The factory is what stops that.

import type { AssetId, CircuitAmount } from "../core/brand.js";
import { InsufficientCoverError } from "../core/errors.js";
import type { ConsolidateHint } from "../core/note-record.js";
import type { StoredNote } from "./note-store.js";
import type { CoinSelector, ConsolidateFirst, DirectSelection, SelectOpts } from "./selection.js";

/**
 * Consolidation rounds before giving up.
 *
 * One merge frees `maxInputs - 1` slots' worth of value, so a target needing
 * more than that is unreachable in a single round. Each round costs a
 * self-spend and a wait for its note to age, so this trades latency against
 * reach: three covers the shapes that occur in practice, and a wallet needing
 * more is better served by an explicit sweep than by a transfer quietly doing
 * several.
 */
const MAX_ROUNDS = 3;

export interface CoverArgs {
    asset: AssetId;
    target: CircuitAmount;
    /**
     * Selection options, rebuilt for each attempt.
     *
     * A factory rather than a value so `tipBlock` is re-read between rounds —
     * see the note at the top of this file.
     */
    selectOpts?: (() => Promise<SelectOpts | undefined>) | undefined;
    autoConsolidate?: boolean | undefined;
}

/** Project note records onto the fields a recovery flow needs. */
function hints(notes: readonly StoredNote[]): ConsolidateHint[] {
    return notes.map((n) => ({ id: n.id, value: n.value }));
}

export async function ensureCover(
    selector: CoinSelector,
    notes: () => readonly StoredNote[],
    args: CoverArgs,
    consolidate: (asset: AssetId, sel: ConsolidateFirst) => Promise<void>,
): Promise<DirectSelection> {
    // What the previous round was asked to merge. Unchanged two rounds running
    // means consolidation achieved nothing and another round will not either —
    // a separate stop from `MAX_ROUNDS`, which bounds rounds that *do* progress
    // but never far enough.
    let previous: string | undefined;

    for (let round = 0; ; round++) {
        const sel = selector.select(notes(), args.asset, args.target, await args.selectOpts?.());
        if (sel.plan === "direct") return sel;

        const merge = `${sel.consolidate.length}:${sel.consolidateSum}`;
        if (!args.autoConsolidate || round >= MAX_ROUNDS || merge === previous) {
            throw new InsufficientCoverError({
                target: args.target,
                asset: args.asset,
                consolidate: hints(sel.consolidate),
                consolidateSum: sel.consolidateSum,
                // Consolidation runs at the end of a round body and every throw
                // is at the top of one, so "a round has completed" is exactly
                // "consolidation ran".
                consolidationAttempted: round > 0,
            });
        }
        previous = merge;

        await consolidate(args.asset, sel);
    }
}
