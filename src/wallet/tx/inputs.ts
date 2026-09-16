// Build the `InputSlots` mask for a spend, padding unused slots with `null`
// so the circuit fills them with dummies.

import type { InputSlot, InputSlots } from "../../bundle/common.js";
import type { SpendableCachedNote } from "../../circuit/index.js";
import { randomJubjubScalar } from "../../core/random.js";
import type { Field } from "../../crypto/index.js";
import { assertInvariant, InternalError } from "../../errors/base.js";
import type { TreeStore } from "../../sync/tree-store.js";
import { decodeStoredNote, type StoredNote } from "../notes/note-store.js";

export interface InputsCtx {
    pk: Field;
    nsk: Field;
    treeStore: TreeStore;
    /** Input slots the circuit has. Selection never returns more than this. */
    nIn: number;
    /**
     * The Merkle root the spend proves against. When set, every input's path must lead to it;
     * a path from any other tree state would produce a proof the pool rejects.
     */
    expectedRoot?: Field | undefined;
}

/**
 * Build the input slots for `selected`.
 *
 * Each slot takes its asset from its own stored note. A spend may draw on two
 * assets (the one moved and the one paying the relayer); applying a single
 * asset to all slots would assign fee notes the wrong asset and break Merkle
 * membership in the witness.
 */
export async function buildInputSlots(ctx: InputsCtx, selected: StoredNote[]): Promise<InputSlots> {
    assertInvariant(
        selected.length > 0 && selected.length <= ctx.nIn,
        `buildInputSlots: expected 1..${ctx.nIn} notes, got ${selected.length}`,
    );
    const slots: (InputSlot | null)[] = selected.map((s): InputSlot => {
        const n = decodeStoredNote(s);
        const path = ctx.treeStore.getPath(n.leafIndex);
        if (ctx.expectedRoot !== undefined && path.root !== ctx.expectedRoot) {
            throw new InternalError(
                `input path for leaf ${n.leafIndex} leads to a different Merkle root than the ` +
                    "spend proves against; the tree changed while the inputs were built",
            );
        }
        const cached: SpendableCachedNote = {
            note: {
                asset: n.asset,
                value: n.value,
                pk: ctx.pk,
                rho: n.rho,
                rcm: n.rcm,
                // Fresh per spend: `cv = value·gen + rcv·H` is a public input, so
                // a fixed blinder would expose an unblinded commitment to the
                // amount. `rcvDep` is fixed by the leaf and must not change.
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
