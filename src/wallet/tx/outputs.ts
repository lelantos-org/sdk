// Output slots, as one object each instead of three parallel arrays.
//
// `buildSpend` takes `outputs`, `outputRecipients` and `outputRandomness` as
// three positional arrays and only checks that their lengths match. Building
// them separately means the order has to be repeated three times and kept in
// step by hand — and a slot that drifts between them is not a type error, it is
// a note delivered to the wrong address. The fee slot made that concrete: it is
// the one entry whose recipient is not the sender, so a spread that lands it at
// the wrong index pays the relayer's fee to the payer and vice versa, and every
// balance check still passes.
//
// So a slot is described once, here, and unzipped at the `buildSpend` boundary.
// Ownership rides along for the same reason: `ownIndices` is otherwise index
// arithmetic over an order defined somewhere else.
//
// That shape is also what makes the order safe to randomize, which is the other
// half of this file's job. Slot index is the only thing left in the output
// vector that distinguishes one output from another — every other per-slot
// public signal is a commitment or a blinded point — so a fixed layout would
// publish which commitment is the payee's and which is the relayer's on every
// spend, to anyone reading the chain. With `nOut = 3` that labels up to a third
// of the tree's leaves as relayer-owned, shrinking the cover set every later
// spend draws from.
//
// So `finalizeSlots` shuffles, and it is the only way out of this module: the
// three arrays, `ownIndices` and the payee's index all come back derived from
// one permutation. Exporting the unzip on its own would let a caller shuffle
// for `buildSpend` and read `ownIndices` off the unshuffled list — which type
// checks, proves, submits, and misreports which notes are ours.

import type { OutputRandomness, OutputRecipient } from "../../bundle/common.js";
import type { SpendArgs } from "../../bundle/spend.js";
import { shuffled } from "../../core/random.js";
import type { DecodedAddress } from "../../keys/address.js";
import type { Note } from "../../notes/note.js";
import { freshNoteRandomness, freshOutputAuxRandomness } from "../../notes/randomness.js";
import type { OutputSlot } from "../result-builder.js";

/** One output slot, with everything that must line up at its index. */
export interface OutputSlotSpec {
    note: Note;
    recipient: OutputRecipient;
    randomness: OutputRandomness;
    /** Ours, and so counted in `ownIndices` / `ownInflow`. */
    own: boolean;
    /**
     * The transfer payee's slot — at most one, and only on a transfer.
     *
     * Carried on the slot for the same reason `own` is: after the shuffle there
     * is no index to recover it from, and tracking it alongside would be the
     * drift this file exists to prevent. Both are true at once on a
     * self-transfer.
     */
    payee?: boolean;
}

/** A slot paying `recipient`, with fresh randomness. */
export function payTo(note: Note, recipient: DecodedAddress, own: boolean): OutputSlotSpec {
    return { note, recipient, randomness: freshOutputAuxRandomness(), own };
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

/** {@link splitChange}, as slots addressed back to self. */
export function changeSlots(
    pk: bigint,
    ownAddr: DecodedAddress,
    asset: bigint,
    remainder: bigint,
    count: number,
): OutputSlotSpec[] {
    return splitChange(pk, asset, remainder, count).map((note) => payTo(note, ownAddr, true));
}

/** Everything downstream needs about a spend's outputs, in their final order. */
export interface FinalSlots {
    /** The three positional arrays `buildSpend` takes. Spread into its args. */
    args: Pick<SpendArgs, "outputs" | "outputRecipients" | "outputRandomness">;
    /** Indices of the slots that are ours, in slot order. */
    ownIndices: OutputSlot[];
    /** Where the payee's slot landed, on a transfer. */
    payeeIndex?: OutputSlot;
}

/**
 * Shuffle a spend's output slots and unzip them, in that order.
 *
 * The single exit from this module, so that the shuffle cannot be forgotten by
 * a new spend path and the three arrays, `ownIndices` and `payeeIndex` cannot
 * disagree about where anything went — see the note at the top of this file.
 *
 * Must run before `buildSpend`, which re-derives each output's `rho` from its
 * final index; nothing may reorder the outputs after this.
 *
 * `pick` is the shuffle's randomness, injectable so a test can pin an exact
 * permutation.
 */
export function finalizeSlots(
    slots: readonly OutputSlotSpec[],
    pick?: (n: number) => number,
): FinalSlots {
    const order = shuffled(slots, pick);
    const payeeIndex = order.findIndex((s) => s.payee);
    return {
        args: {
            outputs: order.map((s) => s.note),
            outputRecipients: order.map((s) => s.recipient),
            outputRandomness: order.map((s) => s.randomness),
        },
        ownIndices: order.flatMap((s, i) => (s.own ? [i] : [])),
        ...(payeeIndex >= 0 ? { payeeIndex } : {}),
    };
}
