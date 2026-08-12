// Steps every spend shares.
//
// The cover-selection preamble, the change-note split, the submit-and-finalize
// tail, and the deposit-intent randomness block, shared by transfer, withdraw
// and swap. Each is parameterised rather than assumed identical: transfer
// computes `ownIndices` from a self-transfer check, while withdraw and swap
// pass `[0, 1]`.

import type { InputSlots } from "../../bundle/common.js";
import type { AssetId, CircuitAmount } from "../../core/brand.js";
import { safePhase } from "../../core/callbacks.js";
import type { DecodedAddress } from "../../keys/address.js";
import { decodeAddress } from "../../keys/address.js";
import type { Note } from "../../notes/note.js";
import {
    freshNoteRandomness,
    freshOutput,
    type NoteOutputRandomness,
} from "../../notes/randomness.js";
import type { OnPhase, SpendPhase } from "../api.js";
import type { SpendContext } from "../context.js";
import { inputsCtx } from "../context.js";
import { ensureCover } from "../cover.js";
import { buildInputSlots } from "../inputs.js";
import type { DirectSelection, SelectOpts } from "../selection.js";

export interface PreparedSpend {
    /** Already narrowed: `ensureCover` resolves the consolidate case. */
    selection: DirectSelection;
    /** Own decoded shielded address — the change recipient. */
    ownAddr: DecodedAddress;
    inputs: InputSlots;
    merkleRoot: bigint;
}

/**
 * Select cover, sync the tree, and build the input slots.
 *
 * `target` is the full amount that must be covered, fee included — the
 * caller computes it, because each flow derives it differently.
 */
export async function prepareSpend(
    ctx: SpendContext,
    args: {
        asset: AssetId;
        target: CircuitAmount;
        selectOpts?: SelectOpts | undefined;
        autoConsolidate?: boolean | undefined;
        onPhase?: OnPhase<SpendPhase> | undefined;
    },
): Promise<PreparedSpend> {
    safePhase(args.onPhase, "preparing");
    const selection = await ensureCover(
        ctx.selector,
        () => ctx.storedNotes(),
        {
            asset: args.asset,
            target: args.target,
            // The circuit's arity is the ceiling; a caller may lower it but
            // not raise it past what the proof can consume.
            selectOpts: { maxInputs: ctx.cfg.shape.nIn, ...args.selectOpts },
            autoConsolidate: args.autoConsolidate,
        },
        (a, sel) => ctx.autoConsolidate(a, sel),
    );

    const ownAddr = decodeAddress(ctx.J, ctx.address);
    await ctx.treeStore.sync();
    const inputs = await buildInputSlots(inputsCtx(ctx), selection.notes, args.asset);

    return { selection, ownAddr, inputs, merkleRoot: ctx.treeStore.root() };
}

/**
 * Split a change remainder evenly across `slots` output notes.
 *
 * Every slot is used: an unused one would be a zero-value pad, and several
 * roughly equal notes preserve a multi-note cover for the next spend.
 *
 * An indivisible remainder goes to the *last* slots, so at two slots this
 * emits `[floor(r/2), ceil(r/2)]` — the same pair, in the same order, as the
 * two-slot-only version this replaced.
 */
export function splitChange(pk: bigint, asset: bigint, remainder: bigint, slots: number): Note[] {
    if (slots < 1) throw new Error(`splitChange: need at least one slot, got ${slots}`);
    const n = BigInt(slots);
    const base = remainder / n;
    const extra = remainder % n;
    return Array.from({ length: slots }, (_, i) => ({
        asset,
        value: base + (BigInt(i) >= n - extra ? 1n : 0n),
        pk,
        ...freshNoteRandomness(),
    }));
}

/** Fresh randomness for a deposit intent's single output slot. */
export function freshDepositSlots(): { output0: NoteOutputRandomness } {
    return { output0: freshOutput() };
}
