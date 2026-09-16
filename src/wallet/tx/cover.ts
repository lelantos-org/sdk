// Coin-cover helper shared by `transfer` and `withdraw`: select notes,
// consolidate and retry, or throw on insufficient cover.
//
// **Options are re-read per attempt.** `selectOpts` carries `tipBlock`, and the
// cooldown rule is `tip - firstSeenBlock < cooldownBlocks`. Consolidation
// creates a note at or after the tip the first attempt saw, so a retry reusing
// that tip would always exclude the merged note.

import type { AssetId, CircuitAmount } from "../../core/brand.js";
import { InvalidArgumentError } from "../../errors/config.js";
import type { ConsolidateHint } from "../../errors/funds.js";
import {
    InsufficientBalanceError,
    InsufficientCoverError,
    NotesHeldError,
} from "../../errors/funds.js";
import type { NoteLeases } from "../notes/leases.js";
import type { StoredNote } from "../notes/note-store.js";
import type {
    CoinSelector,
    ConsolidateFirst,
    DirectSelection,
    SelectOpts,
} from "../selection/index.js";
import { fundingError, spendRules } from "../selection/spendability.js";
import type { SelectionOptions } from "../types/options.js";

/**
 * Consolidation rounds before giving up.
 *
 * One merge frees `maxInputs - 1` slots' worth of value, so some targets need
 * several rounds. Each round costs a self-spend and a wait for its note to age;
 * three rounds cover typical note sets, and wallets needing more should use an
 * explicit sweep.
 */
const MAX_ROUNDS = 3;

interface CoverArgs {
    asset: AssetId;
    target: CircuitAmount;
    /**
     * Selection options, rebuilt for each attempt.
     *
     * A factory so `tipBlock` is re-read between rounds; see the note at the top
     * of this file.
     */
    selectOpts?: (() => Promise<SelectOpts | undefined>) | undefined;
    autoConsolidate?: boolean | undefined;
}

/** Project note records onto the fields a recovery flow needs. */
function hints(notes: readonly StoredNote[]): ConsolidateHint[] {
    return notes.map((n) => ({ id: n.id, value: n.value }));
}

/**
 * Select cover for `args.target`, consolidating and retrying when allowed.
 *
 * With `leases`, each selection runs under the lease lock over the notes no in-flight spend holds,
 * and a direct selection's notes are leased before the lock is released, so concurrent spends
 * receive disjoint notes. The caller owns the returned lease. A consolidate-first plan leases
 * nothing: the self-spend that merges those notes takes its own.
 */
export async function ensureCover(
    selector: CoinSelector,
    notes: () => readonly StoredNote[],
    args: CoverArgs,
    consolidate: (asset: AssetId, sel: ConsolidateFirst) => Promise<void>,
    leases?: NoteLeases | undefined,
): Promise<DirectSelection> {
    const attempt = async () => {
        const opts = await args.selectOpts?.();
        const all = notes();
        const pool = leases ? leases.available(all) : all;
        let sel: ReturnType<CoinSelector["select"]>;
        try {
            sel = selector.select(pool, args.asset, args.target, opts);
        } catch (err) {
            throw withLeasedNotes(err, all, args.asset, opts, leases);
        }
        if (sel.plan === "direct") leases?.lease(sel.notes.map((n) => n.id));
        return sel;
    };

    // What the previous round was asked to merge. An identical merge in two
    // consecutive rounds means consolidation made no progress. This is separate
    // from `MAX_ROUNDS`, which bounds rounds that progress without reaching cover.
    let previous: string | undefined;

    for (let round = 0; ; round++) {
        const sel = leases ? await leases.select(attempt) : await attempt();
        if (sel.plan === "direct") return sel;

        const merge = `${sel.consolidate.length}:${sel.consolidateSum}`;
        if (!args.autoConsolidate || round >= MAX_ROUNDS || merge === previous) {
            throw new InsufficientCoverError({
                target: args.target,
                asset: args.asset,
                reason: "arity",
                consolidate: hints(sel.consolidate),
                consolidateSum: sel.consolidateSum,
                // Consolidation runs at the end of each round and this throw is at
                // the start, so `round > 0` means consolidation ran.
                consolidationAttempted: round > 0,
            });
        }
        previous = merge;

        await consolidate(args.asset, sel);
    }
}

/**
 * Rebuild a selector's funding error with the notes this wallet's in-flight
 * spends hold.
 *
 * The selector only sees notes no lease holds, so a spend losing a race with a
 * concurrent one would otherwise read "insufficient balance" although the notes
 * exist and are merely busy. Counting them as reserved turns that into
 * `NOTES_HELD`, which is retryable once the other spend settles.
 */
function withLeasedNotes(
    err: unknown,
    all: readonly StoredNote[],
    asset: AssetId,
    opts: SelectOpts | undefined,
    leases: NoteLeases | undefined,
): unknown {
    if (!leases || leases.size === 0) return err;
    if (!(err instanceof InsufficientBalanceError || err instanceof NotesHeldError)) return err;
    if (err.asset !== asset) return err;
    return fundingError(all, asset, err.required, { ...spendRules(opts ?? {}), leased: leases });
}

/**
 * A caller's selection rules, minus `fee` and `tipBlock`: the SDK supplies both, and a caller value
 * would double-count the fee or freeze the cooldown.
 */
export function selectionRules(selection: unknown): SelectionOptions | undefined {
    if (selection === undefined) return undefined;
    if (typeof selection !== "object" || selection === null) {
        throw new InvalidArgumentError("selection must be an object", { argument: "selection" });
    }
    const { fee: _fee, tipBlock: _tip, ...rules } = selection as SelectOpts;
    return rules;
}

/** `selection`'s rules at `maxInputs` (which a caller may lower, never raise) and the tip. */
export function withSelection(
    selection: SelectionOptions | undefined,
    maxInputs: number,
    tipBlock: number | undefined,
): SelectOpts {
    return {
        ...selection,
        maxInputs: Math.min(maxInputs, selection?.maxInputs ?? maxInputs),
        ...(tipBlock !== undefined ? { tipBlock } : {}),
    };
}
