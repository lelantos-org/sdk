// Output slots, one object each.
//
// `buildSpend` takes `outputs`, `outputRecipients` and `outputRandomness` as positional arrays and
// checks only that their lengths match. A slot that drifts between them delivers a note to the
// wrong address; a misplaced fee slot pays the relayer's fee to the payer while every balance check
// still passes. Each slot is described once here, with its ownership, and unzipped at the
// `buildSpend` boundary.
//
// Slot index is the only per-slot public signal that is not a commitment or a blinded point, so a
// fixed layout would reveal which commitment is the payee's and which the relayer's. The order is
// shuffled.
//
// `finalizeSlots` shuffles and is the only exit from this module, so the three arrays, `ownIndices`
// and the payee's index derive from one permutation. `ownIndices` read off the unshuffled list
// would prove and submit while misreporting note ownership.

import type { OutputRandomness, OutputRecipient } from "../../bundle/common.js";
import type { SpendArgs } from "../../bundle/spend.js";
import { shuffled } from "../../core/random.js";
import { assertInvariant, InternalError } from "../../errors/base.js";
import type { DecodedAddress } from "../../keys/address.js";
import type { Note } from "../../notes/note.js";
import { freshNoteRandomness, freshOutputAuxRandomness } from "../../notes/randomness.js";
import { decompose, type Ladder } from "../../protocol/denominations.js";
import type { OutputSlot } from "./result-builder.js";

/** One output slot, with everything that must line up at its index. */
export interface OutputSlotSpec {
    note: Note;
    recipient: OutputRecipient;
    randomness: OutputRandomness;
    /** Owned by this wallet, and so counted in `ownIndices` / `ownInflow`. */
    own: boolean;
    /**
     * The transfer payee's slot; at most one, and only on a transfer. Carried on the slot because
     * the shuffle leaves no index to recover it from. Both `own` and `payee` are true on a
     * self-transfer.
     */
    payee?: boolean;
}

/** A slot paying `recipient`, with fresh randomness. */
export function payTo(note: Note, recipient: DecodedAddress, own: boolean): OutputSlotSpec {
    return { note, recipient, randomness: freshOutputAuxRandomness(), own };
}

/** What a change split needs to know. See {@link splitChange}. */
interface ChangeSplit {
    /** Owner of every note produced — the spender's own `pk`. */
    pk: bigint;
    asset: bigint;
    /** Value to distribute. The notes always sum to exactly this. */
    remainder: bigint;
    /** Output slots available. Exactly this many notes come back. */
    slots: number;
    /** Denominations to decompose onto. Omit, or pass an empty ladder, to split evenly. */
    ladder?: Ladder | undefined;
}

/**
 * Split a change remainder across `slots` output notes.
 *
 * With a ladder, the remainder is decomposed onto it greedily, largest first, with any off-ladder
 * leftover in one final note. `publicOut` must be a denomination for a withdrawal to blend with
 * others, so off-ladder change cannot be withdrawn until re-split. An internal transfer publishes
 * no amount, so a later self-spend can re-split the leftover without disclosure.
 *
 * Without a ladder, the remainder is split evenly across every slot, which preserves a multi-note
 * cover for the next spend. An indivisible remainder goes to the last slots, so two slots yield
 * `[floor(r/2), ceil(r/2)]`.
 *
 * Either way exactly `slots` notes are returned and their values sum to `remainder` exactly, as
 * the circuit's value conservation requires; an unused slot is a value-0 note to self.
 */
export function splitChange(args: ChangeSplit): Note[] {
    const { pk, asset, remainder, slots, ladder } = args;
    assertInvariant(slots >= 1, `splitChange: need at least one slot, got ${slots}`);
    // `WalletConfig.denominations: false` resolves to an empty ladder. Decomposing against it would
    // put the whole remainder in the dust slot, and `[]` is truthy, hence the length check.
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
    // Unreachable: `decompose` reserves a slot for the remainder. An over-long list would drop
    // outputs at `buildSpend` and unbalance the proof.
    if (values.length > slots) {
        throw new InternalError(
            `splitChange: decomposed ${remainder} into ${values.length} notes for ${slots} slots`,
        );
    }
    // Padded, never truncated: `buildSpend` takes exactly `nOut` outputs.
    while (values.length < slots) values.push(0n);
    return values;
}

/** {@link splitChange}, as slots addressed back to self. */
export function changeSlots(args: ChangeSplit & { ownAddr: DecodedAddress }): OutputSlotSpec[] {
    return splitChange(args).map((note) => payTo(note, args.ownAddr, true));
}

/** Everything downstream needs about a spend's outputs, in their final order. */
interface FinalSlots {
    /** The three positional arrays `buildSpend` takes. Spread into its args. */
    args: Pick<SpendArgs, "outputs" | "outputRecipients" | "outputRandomness">;
    /** Indices of the wallet's own slots, in slot order. */
    ownIndices: OutputSlot[];
    /** Where the payee's slot landed, on a transfer. */
    payeeIndex?: OutputSlot;
}

/**
 * Shuffle a spend's output slots and unzip them, in that order, so the three arrays, `ownIndices`
 * and `payeeIndex` agree on one permutation (see the file header).
 *
 * Must run before `buildSpend`, which derives each output's `rho` from its final index; nothing
 * may reorder the outputs afterwards.
 *
 * `pick` is the shuffle's randomness, injectable to pin a permutation in tests.
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
