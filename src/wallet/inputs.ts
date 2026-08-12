// Build the `InputSlots` mask for a spend, padding unused slots with `null`
// so the circuit fills them with dummies.

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
    /** Input slots the circuit has. Selection never returns more than this. */
    nIn: number;
}

export async function buildInputSlots(
    ctx: InputsCtx,
    selected: StoredNote[],
    asset: bigint,
): Promise<InputSlots> {
    if (selected.length === 0 || selected.length > ctx.nIn) {
        throw new Error(`buildInputSlots: expected 1..${ctx.nIn} notes, got ${selected.length}`);
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
    while (slots.length < ctx.nIn) slots.push(null);
    return slots;
}
