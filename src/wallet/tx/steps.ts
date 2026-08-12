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
    type NoteRandomness,
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
            selectOpts: args.selectOpts,
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
 * Split a change remainder across both output slots.
 *
 * Both slots are always used: an unused slot would be a zero-value pad,
 * and two equalish notes preserve a 2-note cover for the next spend.
 */
export function splitChangePair(pk: bigint, asset: bigint, remainder: bigint): [Note, Note] {
    const half = remainder / 2n;
    return [
        { asset, value: half, pk, ...freshNoteRandomness() },
        { asset, value: remainder - half, pk, ...freshNoteRandomness() },
    ];
}

/** Fresh randomness for a deposit intent's real slot plus its pad slot. */
export function freshDepositSlots(): {
    output0: NoteOutputRandomness;
    output1Pad: NoteRandomness;
} {
    return { output0: freshOutput(), output1Pad: freshNoteRandomness() };
}
