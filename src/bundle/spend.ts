// Spend bundle builder — proves transact_2x2 for every spend kind.
//
// `buildTransfer`, `buildWithdraw` and `buildWithdrawNative` share one
// six-step skeleton; transfer is the withdraw shape with `publicOut = 0`.
//
// `kind` flows into `SubmitTransactPayload.kind`, which routes the on-chain
// call, so it is a required argument here rather than something a wrapper
// supplies. `spend.test.ts` asserts each kind end to end.

import type { Field } from "../crypto/index.js";
import type { Note } from "../notes/note.js";
import type { SpendKind } from "../protocol/transact.js";
import {
    type BuiltBundle,
    type BundleCommon,
    buildAuxForReal,
    buildInputs,
    deriveOutputRho,
    finalize,
    type InputSlots,
    type OutputRandomness,
    type OutputRecipient,
} from "./common.js";

export interface SpendArgs extends BundleCommon {
    /** Which on-chain entry point the relayer should call. */
    kind: SpendKind;
    inputs: InputSlots;
    merkleRoot: Field;
    /**
     * Two output notes. For a transfer these are the send and change notes;
     * for a withdraw both are change back to self. Together they must sum to
     * `total real input value − publicOut`.
     */
    outputs: [Note, Note];
    /**
     * Recipient address per output slot (drives the FMD clue + ECDH).
     * Pass your own address for change slots.
     */
    outputRecipients: [OutputRecipient, OutputRecipient];
    outputRandomness: [OutputRandomness, OutputRandomness];
    /** Value leaving the shielded pool. 0 for a transfer. */
    publicOut?: bigint;
}

export async function buildSpend(a: SpendArgs): Promise<BuiltBundle> {
    const { P, J, kind } = a;
    const publicOut = a.publicOut ?? 0n;

    if (a.inputs.every((s) => s == null)) {
        throw new Error(`${kind}: at least one real input required`);
    }

    const sumIn = a.inputs.reduce((acc, s) => acc + (s?.cached.note.value ?? 0n), 0n);
    const sumOut = a.outputs[0].value + a.outputs[1].value;
    if (sumIn !== publicOut + sumOut) {
        throw new Error(`${kind} balance: in=${sumIn} publicOut=${publicOut} out=${sumOut}`);
    }

    const realIns = buildInputs(P, a.inputs, a.treeDepth);
    const outputs = deriveOutputRho(P, realIns[0].nf, a.outputs);
    const aux0 = buildAuxForReal(J, P, outputs[0], a.outputRecipients[0], a.outputRandomness[0]);
    const aux1 = buildAuxForReal(J, P, outputs[1], a.outputRecipients[1], a.outputRandomness[1]);

    return finalize(a, kind, realIns, outputs, a.merkleRoot, 0n, publicOut, [aux0, aux1]);
}
