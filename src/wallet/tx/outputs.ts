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

import type { OutputRandomness, OutputRecipient } from "../../bundle/common.js";
import type { SpendArgs } from "../../bundle/spend.js";
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

/** The three positional arrays `buildSpend` takes, from one ordered list. */
export function spendOutputs(
    slots: readonly OutputSlotSpec[],
): Pick<SpendArgs, "outputs" | "outputRecipients" | "outputRandomness"> {
    return {
        outputs: slots.map((s) => s.note),
        outputRecipients: slots.map((s) => s.recipient),
        outputRandomness: slots.map((s) => s.randomness),
    };
}

/** Indices of the slots that are ours, in slot order. */
export function ownIndices(slots: readonly OutputSlotSpec[]): OutputSlot[] {
    return slots.flatMap((s, i) => (s.own ? [i] : []));
}
