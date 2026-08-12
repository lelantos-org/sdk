// Transfer transaction logic. Backs `Wallet.transfer`.

import { buildSpend } from "../bundle/spend.js";
import { branded, type CircuitAmount } from "../core/brand.js";
import { safePhase } from "../core/callbacks.js";
import { decodeAddress } from "../keys/address.js";
import type { Note } from "../notes/note.js";
import { freshNoteRandomness, freshOutputAuxRandomness } from "../notes/randomness.js";
import type { TransferOptions, TransferResult } from "./api.js";
import { DEFAULT_ASSET } from "./constants.js";
import type { SpendContext } from "./context.js";
import { makeTransactionResult, type OutputSlot } from "./internal.js";
import { prepareSpend } from "./tx/steps.js";

export async function executeTransfer(
    ctx: SpendContext,
    args: TransferOptions,
): Promise<TransferResult> {
    const asset = args.asset ?? DEFAULT_ASSET;
    const sendValue = args.amount;

    const { selection, ownAddr, inputs, merkleRoot } = await prepareSpend(ctx, {
        asset,
        target: sendValue,
        selectOpts: args.selectOpts,
        autoConsolidate: args.autoConsolidate,
        onPhase: args.onPhase,
    });
    const recipient = decodeAddress(ctx.J, args.to);

    const changeValue = branded<CircuitAmount>(selection.sum - sendValue);
    const sendNote: Note = {
        asset,
        value: sendValue,
        pk: recipient.pk,
        ...freshNoteRandomness(),
    };
    const changeNote: Note = {
        asset,
        value: changeValue,
        pk: ctx.keys.pk,
        ...freshNoteRandomness(),
    };

    safePhase(args.onPhase, "proving");
    const built = await buildSpend({
        kind: "transfer",
        P: ctx.P,
        J: ctx.J,
        chainId: ctx.cfg.chainId,
        asset,
        payerAddress: ctx.cfg.relayerAddress,
        relayerAddress: ctx.cfg.relayerAddress,
        recipientAddress: ctx.cfg.relayerAddress,
        prover: ctx.prover,
        treeDepth: ctx.cfg.treeDepth,
        inputs,
        merkleRoot,
        outputs: [sendNote, changeNote],
        outputRecipients: [recipient, ownAddr],
        outputRandomness: [freshOutputAuxRandomness(), freshOutputAuxRandomness()],
    });

    safePhase(args.onPhase, "submitting");
    const { txHash } = await ctx.submitter.submit(built.payload);
    const spent = selection.notes.map((n) => n.id);
    await ctx.markSpent(spent);
    // Output 0 = recipient (own only if self-transfer); output 1 = change.
    const isSelf = args.to === ctx.address;
    const ownIndices: OutputSlot[] = isSelf ? [0, 1] : [1];
    return makeTransactionResult({
        kind: "transfer",
        txHash,
        built,
        spent,
        inputSum: selection.sum,
        sent: sendValue,
        change: changeValue,
        ownIndices,
    });
}
