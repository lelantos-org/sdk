// What one spend can reach, and what is holding the rest back.

import { type AssetId, branded, type CircuitAmount } from "../../core/brand.js";
import { cmpBigint } from "../../core/compare.js";
import { DEFAULT_SHAPE } from "../../core/shape.js";
import type { StoredNote } from "../note-store.js";
import { partitionSpendable, spendRules, sum } from "./spendability.js";
import type { SelectOpts, SpendableMax } from "./types.js";

/**
 * The largest amount of `asset` one spend can cover.
 *
 * The sum of the largest `maxInputs` selectable notes, less `reserve` (a fee
 * taken from this same asset). Exists so a UI's "max" is the selector's own
 * answer rather than a balance the selector will then refuse — the two differ
 * by every rule in `partitionSpendable`, and a max built on the balance
 * produces `InsufficientCoverError` against a figure the UI itself wrote.
 *
 * Taking the *largest* notes is what makes this a true ceiling: the selector
 * looks for the smallest cover clearing the target, so at the ceiling the only
 * cover that exists is exactly this set.
 *
 * @internal
 */
export function spendableMax(
    all: readonly StoredNote[],
    asset: AssetId,
    opts: SelectOpts = {},
): SpendableMax {
    // Negative is meaningless and would make `slice(0, n)` empty while
    // `slice(n)` returns everything — clamped once rather than guarded twice.
    const n = Math.max(0, opts.maxInputs ?? DEFAULT_SHAPE.nIn);
    const { candidates, withheld } = partitionSpendable(all, asset, spendRules(opts));

    const desc = candidates.map((note) => BigInt(note.value)).sort((a, b) => cmpBigint(b, a));
    // `fee` rather than a second name for it: `selectNotes` already spends a
    // same-asset fee out of the same cover, by raising the threshold.
    const net = sum(desc.slice(0, n)) - (opts.fee ?? 0n);

    return {
        max: branded<CircuitAmount>(net > 0n ? net : 0n),
        withheld: { ...withheld, slots: sum(desc.slice(n)) },
    };
}
