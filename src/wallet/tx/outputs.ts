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
//
// Every output carries an FMD clue, and a detector holding a wallet's detection key sees which
// clues match it. A clue for another key matches with probability `2^-γ`, so a spend whose unused
// slots were all addressed to the spender would match on most of its outputs and identify its
// sender to that detector. Change is therefore capped at `MAX_CHANGE_NOTES`, and every remaining
// slot is a pad addressed to a key drawn for that slot (`padSlots`).

import type { OutputRandomness, OutputRecipient } from "../../bundle/common.js";
import type { SpendArgs } from "../../bundle/spend.js";
import { randomFr, randomJubjubScalar, shuffled } from "../../core/random.js";
import type { Jubjub, Point } from "../../crypto/jubjub.js";
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

/**
 * Most notes one spend addresses back to its own wallet as change, over the spend asset and a
 * cross-asset fee's asset together.
 *
 * Each is an output whose clue matches the spender's detection key (see the file header). With one
 * or two, a spend is one of the `1 - (1 - 2^-γ)^nOut` and `~C(nOut, 2)·4^-γ` of all transactions
 * that match a given key that often by chance: 17% and 1.4% at `γ = 5`, `nOut = 6`.
 */
export const MAX_CHANGE_NOTES = 2;

/** What a change split needs to know. See {@link splitChange}. */
interface ChangeSplit {
    /** Owner of every note produced — the spender's own `pk`. */
    pk: bigint;
    asset: bigint;
    /** Value to distribute. The notes always sum to exactly this. */
    remainder: bigint;
    /** Most notes to produce. */
    maxNotes: number;
    /** Denominations to decompose onto. Omit, or pass an empty ladder, to split evenly. */
    ladder?: Ladder | undefined;
}

/**
 * Split a change remainder into at most `maxNotes` notes, none of value 0.
 *
 * With a ladder, the remainder is decomposed onto it greedily, largest first, with any off-ladder
 * leftover in one final note. `publicOut` must be a denomination for a withdrawal to blend with
 * others, so off-ladder change cannot be withdrawn until re-split. An internal transfer publishes
 * no amount, so a later self-spend can re-split the leftover without disclosure.
 *
 * Without a ladder, the remainder is split evenly, which preserves a multi-note cover for the next
 * spend. An indivisible remainder goes to the last notes, so two notes are
 * `[floor(r/2), ceil(r/2)]`.
 *
 * Either way the values sum to `remainder` exactly, as the circuit's value conservation requires.
 * A zero remainder yields no note.
 */
export function splitChange(args: ChangeSplit): Note[] {
    const { pk, asset, remainder, maxNotes, ladder } = args;
    assertInvariant(maxNotes >= 1, `splitChange: need at least one note, got ${maxNotes}`);
    // `WalletConfig.denominations: false` resolves to an empty ladder. Decomposing against it would
    // put the whole remainder in the dust note, and `[]` is truthy, hence the length check.
    const values =
        ladder && ladder.length > 0
            ? denominatedValues(remainder, maxNotes, ladder)
            : evenValues(remainder, maxNotes);
    return values
        .filter((value) => value > 0n)
        .map((value) => ({ asset, value, pk, ...freshNoteRandomness() }));
}

function evenValues(remainder: bigint, notes: number): bigint[] {
    const n = BigInt(notes);
    const base = remainder / n;
    const extra = remainder % n;
    return Array.from({ length: notes }, (_, i) => base + (BigInt(i) >= n - extra ? 1n : 0n));
}

function denominatedValues(remainder: bigint, maxNotes: number, ladder: Ladder): bigint[] {
    const { pieces, dust } = decompose(remainder, ladder, maxNotes);
    const values = dust > 0n ? [...pieces, dust] : pieces;
    // Unreachable: `decompose` reserves a piece for the remainder. An over-long list would
    // overflow the spend's output slots.
    if (values.length > maxNotes) {
        throw new InternalError(
            `splitChange: decomposed ${remainder} into ${values.length} notes, limit ${maxNotes}`,
        );
    }
    return values;
}

/** {@link splitChange}, as slots addressed back to self. */
export function changeSlots(args: ChangeSplit & { ownAddr: DecodedAddress }): OutputSlotSpec[] {
    return splitChange(args).map((note) => payTo(note, args.ownAddr, true));
}

/** A uniform non-identity point of the prime-order subgroup. */
function randomSubgroupPoint(J: Jubjub): Point {
    return J.mulPointEscalar(J.base8, randomJubjubScalar());
}

/**
 * `count` pads: value-0 notes of `asset`, each addressed to a key drawn for it.
 *
 * A pad's `pk`, `pk_d` and `ck` are uniform and no one holds their secrets, so the note is
 * unspendable, its ciphertext opens for no one, and its clue matches any detection key with the
 * `2^-γ` of an unrelated output. It is built by the same path as a paying output.
 *
 * `asset` is not published: a pad may name any non-zero id.
 */
export function padSlots(J: Jubjub, asset: bigint, count: number): OutputSlotSpec[] {
    return Array.from({ length: count }, () => {
        const recipient: OutputRecipient = {
            pk: randomFr(),
            pk_d: randomSubgroupPoint(J),
            ck: randomSubgroupPoint(J),
            oneTime: true,
        };
        const note: Note = { asset, value: 0n, pk: recipient.pk, ...freshNoteRandomness() };
        return { note, recipient, randomness: freshOutputAuxRandomness(), own: false };
    });
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
