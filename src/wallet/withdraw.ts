// Withdraw transaction logic, extracted from `Wallet.withdraw` /
// `Wallet.withdrawEth`. The single `kind` discriminator routes between
// the ERC-20 and native-ETH builders.

import { buildWithdraw, buildWithdrawNative } from "../bundle/withdraw.js";
import { decodeAddress } from "../keys/address.js";
import type { Note } from "../notes/note.js";
import { freshNoteRandomness, freshOutputAuxRandomness } from "../notes/randomness.js";
import type { TransactionResult, WithdrawOptions } from "./api.js";
import { BPS_DENOMINATOR } from "./constants.js";
import { ensureCover } from "./cover.js";
import { buildInputSlots } from "./inputs.js";
import { makeTransactionResult } from "./internal.js";
import type { Wallet } from "./wallet.js";
import { safePhase } from "./wallet.js";

export type WithdrawKind = "withdraw" | "withdrawNative";

export async function executeWithdraw(
    wallet: Wallet,
    args: WithdrawOptions & { asset: bigint },
    kind: WithdrawKind,
): Promise<TransactionResult> {
    const { asset } = args;
    const feeBps = await wallet.resolveFeeBps();
    const fee = (args.amount * feeBps) / BPS_DENOMINATOR;
    const publicOut = args.amount + fee;

    safePhase(args.onPhase, "preparing");
    const selection = await ensureCover(
        wallet.selector,
        () => wallet.file.notes,
        {
            asset,
            target: publicOut,
            selectOpts: args.selectOpts,
            autoConsolidate: args.autoConsolidate,
        },
        (a, sel) => wallet.autoConsolidate(a, sel),
    );

    const ownAddr = decodeAddress(wallet.J, wallet.address);
    const inputs = await buildInputSlots(wallet.inputsCtx(), selection.notes, asset);

    const remainder = selection.sum - publicOut;
    const half = remainder / 2n;
    const change0: Note = {
        asset,
        value: half,
        pk: wallet.keys.pk,
        ...freshNoteRandomness(),
    };
    const change1: Note = {
        asset,
        value: remainder - half,
        pk: wallet.keys.pk,
        ...freshNoteRandomness(),
    };

    const merkleRoot = (await wallet.noteSource.fetchPath(selection.notes[0].cm)).root;

    safePhase(args.onPhase, "proving");
    const builder = kind === "withdrawNative" ? buildWithdrawNative : buildWithdraw;
    const built = await builder({
        P: wallet.P,
        J: wallet.J,
        chainId: wallet.cfg.chainId,
        asset,
        payerAddress: wallet.cfg.relayerAddress,
        relayerAddress: wallet.cfg.relayerAddress,
        recipientAddress: args.to,
        prover: wallet.prover,
        treeDepth: wallet.cfg.treeDepth,
        inputs,
        merkleRoot,
        publicOut,
        change: [change0, change1],
        changeRecipients: [ownAddr, ownAddr],
        changeRandomness: [freshOutputAuxRandomness(), freshOutputAuxRandomness()],
    });

    safePhase(args.onPhase, "submitting");
    const { txHash } = await wallet.submitter.submit(built.payload);
    const spent = selection.notes.map((n) => n.id);
    await wallet.markSpent(spent);
    return makeTransactionResult({
        kind: "withdraw",
        txHash,
        built,
        spent,
        inputSum: selection.sum,
        sent: publicOut,
        change: remainder,
        // Both outputs are change-to-self.
        ownIndices: [0, 1],
    });
}
