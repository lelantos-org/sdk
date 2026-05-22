// Transfer transaction logic, extracted from `Wallet.transfer`.

import { buildTransfer } from "../bundle/transfer.js";
import { decodeAddress } from "../keys/address.js";
import type { Note } from "../notes/note.js";
import { freshNoteRandomness, freshOutputAuxRandomness } from "../notes/randomness.js";
import type { TransactionResult, TransferOptions } from "./api.js";
import { ensureCover } from "./cover.js";
import { buildInputSlots } from "./inputs.js";
import { makeTransactionResult } from "./internal.js";
import type { Wallet } from "./wallet.js";
import { safePhase } from "./wallet.js";

export async function executeTransfer(
    wallet: Wallet,
    args: TransferOptions,
): Promise<TransactionResult> {
    const asset = args.asset ?? 1n;
    const sendValue = args.amount;

    safePhase(args.onPhase, "preparing");
    const selection = await ensureCover(
        wallet.selector,
        () => wallet.file.notes,
        {
            asset,
            target: sendValue,
            selectOpts: args.selectOpts,
            autoConsolidate: args.autoConsolidate,
        },
        (a, sel) => wallet.autoConsolidate(a, sel),
    );

    const recipient = decodeAddress(wallet.J, args.to);
    const ownAddr = decodeAddress(wallet.J, wallet.address);
    await wallet.treeStore.sync();
    const inputs = await buildInputSlots(wallet.inputsCtx(), selection.notes, asset);

    const changeValue = selection.sum - sendValue;
    const sendNote: Note = {
        asset,
        value: sendValue,
        pk: recipient.pk,
        ...freshNoteRandomness(),
    };
    const changeNote: Note = {
        asset,
        value: changeValue,
        pk: wallet.keys.pk,
        ...freshNoteRandomness(),
    };

    const merkleRoot = wallet.treeStore.root();

    safePhase(args.onPhase, "proving");
    const built = await buildTransfer({
        P: wallet.P,
        J: wallet.J,
        chainId: wallet.cfg.chainId,
        asset,
        payerAddress: wallet.cfg.relayerAddress,
        relayerAddress: wallet.cfg.relayerAddress,
        recipientAddress: wallet.cfg.relayerAddress,
        prover: wallet.prover,
        treeDepth: wallet.cfg.treeDepth,
        inputs,
        merkleRoot,
        outputs: [sendNote, changeNote],
        outputRecipients: [recipient, ownAddr],
        outputRandomness: [freshOutputAuxRandomness(), freshOutputAuxRandomness()],
    });

    safePhase(args.onPhase, "submitting");
    const { txHash } = await wallet.submitter.submit(built.payload);
    const spent = selection.notes.map((n) => n.id);
    await wallet.markSpent(spent);
    // Output 0 = recipient (own only if self-transfer); output 1 = change.
    const isSelf = args.to === wallet.address;
    const ownIndices = isSelf ? [0, 1] : [1];
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
