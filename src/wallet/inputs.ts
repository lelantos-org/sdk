// Build 1- or 2-slot `InputSlots`; pads with `null` for single-input spends.

import type { InputSlot, InputSlots } from "../bundle/common.js";
import type { SpendableCachedNote } from "../circuit/index.js";
import { randomJubjubScalar } from "../core/random.js";
import type { Field } from "../crypto/index.js";
import { decodeStoredNote, type StoredNote } from "./note-store.js";
import type { TreeStore } from "./tree-store.js";

export interface InputsCtx {
    pk: Field;
    nsk: Field;
    treeStore: TreeStore;
}

export async function buildInputSlots(
    ctx: InputsCtx,
    selected: StoredNote[],
    asset: bigint,
): Promise<InputSlots> {
    if (selected.length === 0 || selected.length > 2) {
        throw new Error(`buildInputSlots: expected 1 or 2 notes, got ${selected.length}`);
    }
    const slots: (InputSlot | null)[] = selected.map((s): InputSlot => {
        const n = decodeStoredNote(s);
        const path = ctx.treeStore.getPath(n.leafIndex);
        const cached: SpendableCachedNote = {
            note: {
                asset,
                value: n.value,
                pk: ctx.pk,
                rho: n.rho,
                rcm: n.rcm,
                // Fresh per spend. `cv = value·gen + rcv·H` is a public input,
                // so a fixed blinder would publish an unblinded commitment to
                // the amount. `rcvDep` is fixed by the leaf and must not move.
                rcv: randomJubjubScalar(),
                rcvDep: n.rcvDep,
            },
            nsk: ctx.nsk,
            leafIndex: n.leafIndex,
        };
        return { cached, pathElements: path.pathElements, pathIndices: path.pathIndices };
    });
    while (slots.length < 2) slots.push(null);
    return [slots[0], slots[1]] as InputSlots;
}
