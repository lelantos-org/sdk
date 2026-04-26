// Transfer bundle builder — proves transact_2x2.

import type { Field } from "../crypto/index.js";
import type { Note } from "../notes/note.js";
import {
    type BuiltBundle,
    type BundleCommon,
    buildAuxForReal,
    buildInputs,
    finalize,
    type InputSlots,
    type OutputRandomness,
    type OutputRecipient,
} from "./common.js";

/** @internal */
export interface TransferArgs extends BundleCommon {
    inputs: InputSlots;
    merkleRoot: Field;
    /// Two output notes summing to total real-input value.
    outputs: [Note, Note];
    /// Recipient address per output slot (used to build FMD clue + ECDH).
    /// Pass own address for change slots.
    outputRecipients: [OutputRecipient, OutputRecipient];
    outputRandomness: [OutputRandomness, OutputRandomness];
}

/** @internal */
export async function buildTransfer(a: TransferArgs): Promise<BuiltBundle> {
    const { P, J } = a;
    if (a.inputs.every((s) => s == null))
        throw new Error("transfer: at least one real input required");

    const sumIn = a.inputs.reduce((acc, s) => acc + (s?.cached.note.value ?? 0n), 0n);
    const sumOut = a.outputs[0].value + a.outputs[1].value;
    if (sumOut !== sumIn) {
        throw new Error(`transfer balance: in=${sumIn} out=${sumOut}`);
    }

    const realIns = buildInputs(P, a.inputs, a.treeDepth);
    const aux0 = buildAuxForReal(J, P, a.outputs[0], a.outputRecipients[0], a.outputRandomness[0]);
    const aux1 = buildAuxForReal(J, P, a.outputs[1], a.outputRecipients[1], a.outputRandomness[1]);

    return finalize(a, "transfer", realIns, a.outputs, a.merkleRoot, 0n, 0n, [aux0, aux1]);
}
