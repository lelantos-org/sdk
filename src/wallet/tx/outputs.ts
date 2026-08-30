// Output slots, as one object each instead of three parallel arrays.
//
// `buildSpend` takes `outputs`, `outputRecipients` and `outputRandomness` as
// three positional arrays and checks only that their lengths match. Building
// them separately repeats the order three times: a slot that drifts between
// them is not a type error but a note delivered to the wrong address. The fee
// slot is the one entry whose recipient is not the sender, so a misplaced
// index pays the relayer's fee to the payer and vice versa while every balance
// check still passes.
//
// A slot is therefore described once here and unzipped at the `buildSpend`
// boundary. Ownership rides along for the same reason: `ownIndices` is
// otherwise index arithmetic over an order defined elsewhere.
//
// That shape also makes the order safe to randomize. Slot index is the only
// remaining distinguisher between outputs — every other per-slot public signal
// is a commitment or a blinded point — so a fixed layout would publish which
// commitment is the payee's and which the relayer's on every spend. At
// `nOut = 3` that labels up to a third of the tree's leaves as relayer-owned,
// shrinking the cover set later spends draw from.
//
// `finalizeSlots` shuffles and is the only exit from this module: the three
// arrays, `ownIndices` and the payee's index all derive from one permutation.
// Exporting the unzip separately would let a caller shuffle for `buildSpend`
// and read `ownIndices` off the unshuffled list, which type checks, proves and
// submits while misreporting note ownership.

import type { OutputRandomness, OutputRecipient } from "../../bundle/common.js";
import type { SpendArgs } from "../../bundle/spend.js";
import { decompose, type Ladder } from "../../core/denominations.js";
import { InternalError } from "../../core/errors.js";
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

/** What a change split needs to know. See {@link splitChange}. */
export interface ChangeSplit {
    /** Owner of every note produced — the spender's own `pk`. */
    pk: bigint;
    asset: bigint;
    /** Value to distribute. The notes always sum to exactly this. */
    remainder: bigint;
    /** Output slots available. Exactly this many notes come back. */
    slots: number;
    /**
     * Denominations to decompose onto. Omit — or pass an empty ladder — to
     * split evenly, which is what every asset did before denominations and
     * what a wallet that opted out still does.
     */
    ladder?: Ladder | undefined;
}

/**
 * Split a change remainder across `slots` output notes.
 *
 * **With a ladder**, the remainder is decomposed onto it greedily, largest
 * first, with any off-ladder leftover in one final note. This matters more
 * than it looks: `publicOut` must be a denomination for a withdrawal to blend
 * with anyone else's, so change that lands off-ladder is change that cannot be
 * withdrawn until it has been re-split. Splitting evenly would manufacture
 * unwithdrawable notes on *every* spend, and they compound.
 *
 * Leftover dust is transient rather than permanent — an internal transfer
 * publishes no amount, so a later self-spend re-splits `400 → 200 + 200` for
 * free. That is what makes a bounded slot count workable against a discrete
 * ladder.
 *
 * **Without one**, the remainder is split evenly. Every slot is used: an
 * unused one would be a zero-value pad, and several roughly equal notes
 * preserve a multi-note cover for the next spend. An indivisible remainder
 * goes to the *last* slots, so at two slots this emits
 * `[floor(r/2), ceil(r/2)]`.
 *
 * Either way exactly `slots` notes come back, zero-padded if the split needed
 * fewer — value conservation is enforced in-circuit, so the values must sum to
 * `remainder` exactly and an unused slot is a value-0 note to self.
 */
export function splitChange(args: ChangeSplit): Note[] {
    const { pk, asset, remainder, slots, ladder } = args;
    if (slots < 1) throw new Error(`splitChange: need at least one slot, got ${slots}`);
    // An EMPTY ladder is not "a ladder with nothing in it" — it is the shape a
    // wallet that opted out (`WalletConfig.denominations: false`) resolves onto
    // every asset. Decomposing against it places no pieces and dumps the whole
    // remainder into the dust slot, so this length check is load-bearing: `[]`
    // is truthy.
    const values =
        ladder && ladder.length > 0
            ? denominatedValues(remainder, slots, ladder)
            : evenValues(remainder, slots);
    return values.map((value) => ({ asset, value, pk, ...freshNoteRandomness() }));
}

function evenValues(remainder: bigint, slots: number): bigint[] {
    const n = BigInt(slots);
    const base = remainder / n;
    const extra = remainder % n;
    return Array.from({ length: slots }, (_, i) => base + (BigInt(i) >= n - extra ? 1n : 0n));
}

function denominatedValues(remainder: bigint, slots: number, ladder: Ladder): bigint[] {
    const { pieces, dust } = decompose(remainder, ladder, slots);
    const values = dust > 0n ? [...pieces, dust] : pieces;
    // `decompose` reserves a slot for the remainder, so this cannot trip — but
    // an over-long list would silently drop outputs at `buildSpend` and unbalance
    // the proof, which is a far worse thing to debug than an assertion here.
    if (values.length > slots) {
        throw new InternalError(
            `splitChange: decomposed ${remainder} into ${values.length} notes for ${slots} slots`,
        );
    }
    // Pad rather than truncate: `buildSpend` wants exactly `nOut` outputs, and
    // dropping a slot would drop value the circuit requires to balance.
    while (values.length < slots) values.push(0n);
    return values;
}

/** {@link splitChange}, as slots addressed back to self. */
export function changeSlots(args: ChangeSplit & { ownAddr: DecodedAddress }): OutputSlotSpec[] {
    return splitChange(args).map((note) => payTo(note, args.ownAddr, true));
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
