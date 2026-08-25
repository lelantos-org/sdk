// Transfer transaction logic. Backs `Wallet.transfer`.

import { buildSpend } from "../bundle/spend.js";
import { branded, type CircuitAmount } from "../core/brand.js";
import { safePhase } from "../core/callbacks.js";
import { decodeAddress } from "../keys/address.js";
import type { Note } from "../notes/note.js";
import { freshNoteRandomness } from "../notes/randomness.js";
import { resolveAmount } from "./amount.js";
import type { TransferOptions, TransferResult } from "./api.js";
import { DEFAULT_ASSET } from "./constants.js";
import type { SpendContext } from "./context.js";
import { makeTransactionResult } from "./result-builder.js";
import { feeSlots, resolveFee } from "./tx/fee.js";
import { changeSlots, ownIndices, payTo, spendOutputs } from "./tx/outputs.js";
import { prepareSpend, submitSpend } from "./tx/steps.js";

export async function executeTransfer(
    ctx: SpendContext,
    args: TransferOptions,
): Promise<TransferResult> {
    // Resolve at the boundary: the option types take a name (id, token address
    // or symbol) and a human-or-exact amount, and everything below works in
    // ids and circuit units.
    const info = await ctx.resolveAsset(args.asset ?? DEFAULT_ASSET);
    const asset = info.id;
    const sendValue = resolveAmount(args.amount, info);
    const feeAsset =
        args.feeAsset === undefined ? undefined : (await ctx.resolveAsset(args.feeAsset)).id;

    const fee = await resolveFee(ctx, { kind: "transfer", spendAsset: asset, feeAsset });

    const { selection, feeSelection, ownAddr, inputs, merkleRoot, spentIds, covered } =
        await prepareSpend(ctx, {
            asset,
            target: sendValue,
            fee,
            selectOpts: args.selectOpts,
            autoConsolidate: args.autoConsolidate,
            onPhase: args.onPhase,
        });
    const recipient = decodeAddress(ctx.J, args.to);
    const changeValue = branded<CircuitAmount>(selection.sum - covered);

    const sendNote: Note = {
        asset,
        value: sendValue,
        pk: recipient.pk,
        ...freshNoteRandomness(),
    };

    // Slot 0 is the recipient's, the fee takes what it needs, and the rest is
    // change back to self. Ownership is carried on each slot rather than
    // recomputed as indices afterwards — on a self-transfer slot 0 is ours too.
    //
    // Compared on the decoded `pk`, not on the address string: bech32m permits
    // an all-uppercase spelling and a re-encode is not guaranteed byte-identical
    // either, so a string compare would read as "not self" and under-report a
    // note the caller does own.
    const slots = [
        payTo(sendNote, recipient, recipient.pk === ctx.keys.pk),
        ...changeSlots(
            ctx.keys.pk,
            ownAddr,
            asset,
            changeValue,
            ctx.cfg.shape.nOut - 1 - (fee?.slots ?? 0),
        ),
        ...feeSlots(fee, feeSelection, ctx.keys.pk, ownAddr),
    ];

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
        shape: ctx.cfg.shape,
        inputs,
        merkleRoot,
        ...spendOutputs(slots),
    });

    safePhase(args.onPhase, "submitting");
    const spent = spentIds;
    const { txHash } = await submitSpend(ctx, spent, () => ctx.submitter.submit(built.payload));
    return makeTransactionResult({
        kind: "transfer",
        txHash,
        built,
        spent,
        inputSum: selection.sum,
        sent: sendValue,
        change: changeValue,
        ownIndices: ownIndices(slots),
    });
}
