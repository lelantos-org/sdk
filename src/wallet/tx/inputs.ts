// Build the `InputSlots` mask for a spend, padding unused slots with `null` so the circuit fills
// them with dummies.
//
// The real slots are shuffled. Every output's randomness binds the spend's nullifiers in slot order
// (`sealOutput`), and a spend with no dummy slot has no fresh nullifier, so a rebuild over the same
// notes in the same order would repeat its paying outputs byte for byte while its pads changed.
// The shuffle also keeps the selector's ordering of the notes out of the public nullifier order.

import type { InputSlot, InputSlots } from "../../bundle/common.js";
import type { SpendableCachedNote } from "../../circuit/index.js";
import { shuffled } from "../../core/random.js";
import type { Field, Poseidon } from "../../crypto/index.js";
import { assertInvariant, InternalError } from "../../errors/base.js";
import { deriveDiversifiedPk } from "../../keys/diversified.js";
import type { TreeStore } from "../../sync/tree-store.js";
import { decodeStoredNote, type StoredNote } from "../notes/note-store.js";

export interface InputsCtx {
    P: Poseidon;
    /** Each note's owner key is `Poseidon(TAG_PK, ivk, d)` under the note's own diversifier. */
    ivk: Field;
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
 * Each slot takes its asset from its own stored note. A spend may draw on two assets (the one moved
 * and the one paying the relayer); a single asset applied to all slots would break the fee notes'
 * Merkle membership in the witness.
 *
 * Each slot likewise takes its diversifier from its own stored note: notes received at different
 * addresses of the account are committed under different `pk`.
 *
 * The notes take the leading slots in a uniformly random order (see the file header); the dummies
 * follow. `pick` is the shuffle's randomness, injectable to pin a permutation in tests.
 */
export async function buildInputSlots(
    ctx: InputsCtx,
    selected: StoredNote[],
    pick?: (n: number) => number,
): Promise<InputSlots> {
    assertInvariant(
        selected.length > 0 && selected.length <= ctx.nIn,
        `buildInputSlots: expected 1..${ctx.nIn} notes, got ${selected.length}`,
    );
    const slots: (InputSlot | null)[] = shuffled(selected, pick).map((s): InputSlot => {
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
                pk: deriveDiversifiedPk(ctx.P, ctx.ivk, n.d),
                rho: n.rho,
                rcm: n.rcm,
            },
            nsk: ctx.nsk,
            d: n.d,
            leafIndex: n.leafIndex,
        };
        return { cached, pathElements: path.pathElements, pathIndices: path.pathIndices };
    });
    while (slots.length < ctx.nIn) slots.push(null);
    return slots;
}
