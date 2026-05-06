// Build the 1- or 2-slot `InputSlots` array consumed by transact bundle
// builders. Pads to 2 slots with `null` for single-input spends.

import type { InputSlot, InputSlots } from "../bundle.js";
import type { Field } from "../crypto/index.js";
import type { SpendableCachedNote } from "../witness.js";
import { decodeStoredNote, type StoredNote } from "./note-store.js";
import type { NoteSource } from "./note-source.js";

export interface InputsCtx {
    pk: Field;
    nsk: Field;
    noteSource: NoteSource;
}

export async function buildInputSlots(
    ctx: InputsCtx,
    selected: StoredNote[],
    asset: bigint,
): Promise<InputSlots> {
    if (selected.length === 0 || selected.length > 2) {
        throw new Error(`buildInputSlots: expected 1 or 2 notes, got ${selected.length}`);
    }
    const slots: (InputSlot | null)[] = await Promise.all(
        selected.map(async (s): Promise<InputSlot> => {
            const n = decodeStoredNote(s);
            const path = await ctx.noteSource.fetchPath(n.cm);
            const cached: SpendableCachedNote = {
                note: {
                    asset,
                    value: n.value,
                    pk: ctx.pk,
                    rho: n.rho,
                    rcm: n.rcm,
                    rcv: 0n,
                },
                nsk: ctx.nsk,
                leafIndex: n.leafIndex,
            };
            return { cached, pathElements: path.pathElements, pathIndices: path.pathIndices };
        }),
    );
    while (slots.length < 2) slots.push(null);
    return [slots[0], slots[1]] as InputSlots;
}
