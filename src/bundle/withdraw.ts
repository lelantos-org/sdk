// Withdraw bundle builders — proves transact_2x2 with publicOut > 0.
// `buildWithdrawNative` tags `kind: "withdrawNative"` so the relayer routes
// to `MASP.withdrawNative`, which unwraps WETH → ETH for the recipient.

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
export interface WithdrawArgs extends BundleCommon {
    inputs: InputSlots;
    merkleRoot: Field;
    publicOut: bigint;
    /// Two change notes (back to self), summing to total real-input value − publicOut.
    change: [Note, Note];
    changeRecipients: [OutputRecipient, OutputRecipient];
    changeRandomness: [OutputRandomness, OutputRandomness];
}

export async function buildWithdraw(a: WithdrawArgs): Promise<BuiltBundle> {
    const { P, J } = a;
    if (a.inputs.every((s) => s == null))
        throw new Error("withdraw: at least one real input required");

    const sumIn = a.inputs.reduce((acc, s) => acc + (s?.cached.note.value ?? 0n), 0n);
    const sumChange = a.change[0].value + a.change[1].value;
    if (sumIn !== a.publicOut + sumChange) {
        throw new Error(
            `withdraw balance: in=${sumIn} publicOut=${a.publicOut} change=${sumChange}`,
        );
    }

    const realIns = buildInputs(P, a.inputs, a.treeDepth);
    const aux0 = buildAuxForReal(J, P, a.change[0], a.changeRecipients[0], a.changeRandomness[0]);
    const aux1 = buildAuxForReal(J, P, a.change[1], a.changeRecipients[1], a.changeRandomness[1]);

    return finalize(a, "withdraw", realIns, a.change, a.merkleRoot, 0n, a.publicOut, [aux0, aux1]);
}

/** @internal */
export interface WithdrawNativeArgs extends WithdrawArgs {}

/** @internal */
/// Same shape as `buildWithdraw` but tags the payload `kind: "withdrawNative"`
/// so the relayer routes to `MASP.withdrawNative`. The MASP contract unwraps
/// WETH and forwards raw ETH to `recipientAddress`. Caller is responsible
/// for ensuring `asset` is the registered WETH asset id.
export async function buildWithdrawNative(a: WithdrawNativeArgs): Promise<BuiltBundle> {
    const { P, J } = a;
    if (a.inputs.every((s) => s == null))
        throw new Error("withdrawNative: at least one real input required");

    const sumIn = a.inputs.reduce((acc, s) => acc + (s?.cached.note.value ?? 0n), 0n);
    const sumChange = a.change[0].value + a.change[1].value;
    if (sumIn !== a.publicOut + sumChange) {
        throw new Error(
            `withdrawNative balance: in=${sumIn} publicOut=${a.publicOut} change=${sumChange}`,
        );
    }

    const realIns = buildInputs(P, a.inputs, a.treeDepth);
    const aux0 = buildAuxForReal(J, P, a.change[0], a.changeRecipients[0], a.changeRandomness[0]);
    const aux1 = buildAuxForReal(J, P, a.change[1], a.changeRecipients[1], a.changeRandomness[1]);

    return finalize(a, "withdrawNative", realIns, a.change, a.merkleRoot, 0n, a.publicOut, [
        aux0,
        aux1,
    ]);
}
