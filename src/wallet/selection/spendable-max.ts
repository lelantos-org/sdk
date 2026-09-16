// What one spend can reach, and what is holding the rest back.

import { type AssetId, branded, type CircuitAmount } from "../../core/brand.js";
import { cmpBigint } from "../../core/compare.js";
import { DEFAULT_SHAPE } from "../../protocol/shape.js";
import type { StoredNote } from "../notes/note-store.js";
import { partitionSpendable, spendRules, sum } from "./spendability.js";
import type { SelectOpts, SpendableMax } from "./types.js";

/**
 * The largest amount of `asset` one spend can cover.
 *
 * The sum of the largest `maxInputs` selectable notes, less `reserve` (a fee
 * taken from this same asset). A UI "max" derived from the balance would ignore
 * the rules in `partitionSpendable` and fail with `InsufficientCoverError`.
 *
 * Taking the largest notes makes this a true ceiling: the selector looks for
 * the smallest cover clearing the target, so at the ceiling this set is the
 * only cover.
 *
 * @internal
 */
export function spendableMax(
    all: readonly StoredNote[],
    asset: AssetId,
    opts: SelectOpts = {},
    /** Notes an in-flight spend holds; counted as `withheld.reserved`. */
    leased?: { has(id: string): boolean } | undefined,
): SpendableMax {
    // Clamped: a negative `n` would make `slice(0, n)` and `slice(n)` disagree.
    const n = Math.max(0, opts.maxInputs ?? DEFAULT_SHAPE.nIn);
    const { candidates, withheld } = partitionSpendable(all, asset, {
        ...spendRules(opts),
        ...(leased ? { leased } : {}),
    });

    const desc = candidates.map((note) => BigInt(note.value)).sort((a, b) => cmpBigint(b, a));
    // Uses `fee`, as `selectNotes` does when raising its threshold for a
    // same-asset fee.
    const net = sum(desc.slice(0, n)) - (opts.fee ?? 0n);

    return {
        max: branded<CircuitAmount>(net > 0n ? net : 0n),
        withheld: { ...withheld, slots: sum(desc.slice(n)) },
    };
}
