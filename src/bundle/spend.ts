// Spend bundle builder — proves the transact circuit for every spend kind.
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
     * One note per output slot. For a transfer these are the send note and
     * the change notes; for a withdraw all are change back to self. Together
     * they must sum to `total real input value − publicOut`.
     */
    outputs: readonly Note[];
    /**
     * Recipient address per output slot (drives the FMD clue + ECDH).
     * Change slots take the sender's own address.
     */
    outputRecipients: readonly OutputRecipient[];
    outputRandomness: readonly OutputRandomness[];
    /** Value leaving the shielded pool. 0 for a transfer. */
    publicOut?: bigint;
}

export async function buildSpend(a: SpendArgs): Promise<BuiltBundle> {
    const { P, J, kind } = a;
    const publicOut = a.publicOut ?? 0n;

    if (a.inputs.every((s) => s == null)) {
        throw new Error(`${kind}: at least one real input required`);
    }
    if (
        a.outputs.length !== a.outputRecipients.length ||
        a.outputs.length !== a.outputRandomness.length
    ) {
        throw new Error(
            `${kind}: outputs, outputRecipients and outputRandomness must be the same length ` +
                `(got ${a.outputs.length}, ${a.outputRecipients.length}, ${a.outputRandomness.length})`,
        );
    }

    const sumIn = a.inputs.reduce((acc, s) => acc + (s?.cached.note.value ?? 0n), 0n);
    const sumOut = a.outputs.reduce((acc, o) => acc + o.value, 0n);
    if (sumIn !== publicOut + sumOut) {
        throw new Error(`${kind} balance: in=${sumIn} publicOut=${publicOut} out=${sumOut}`);
    }

    const realIns = buildInputs(P, a.inputs, a.treeDepth);
    const firstNullifier = realIns[0]?.nf;
    if (firstNullifier === undefined) throw new Error(`${kind}: no input slots`);

    const outputs = deriveOutputRho(P, firstNullifier, a.outputs);
    const aux = outputs.map((note, i) =>
        buildAuxForReal(J, P, note, a.outputRecipients[i]!, a.outputRandomness[i]!),
    );

    return finalize(a, kind, realIns, outputs, a.merkleRoot, 0n, publicOut, aux);
}
