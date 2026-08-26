// Transfer transaction logic. Backs `Wallet.transfer`.

import { buildSpend } from "../bundle/spend.js";
import { branded, type CircuitAmount } from "../core/brand.js";
import { safePhase } from "../core/callbacks.js";
import { InvalidArgumentError } from "../core/errors.js";
import { decodeAddress } from "../keys/address.js";
import type { Note } from "../notes/note.js";
import { freshNoteRandomness } from "../notes/randomness.js";
import { resolveAmount } from "./amount.js";
import type { TransferOptions, TransferResult } from "./api.js";
import { DEFAULT_ASSET } from "./constants.js";
import type { SpendContext } from "./context.js";
import { makeTransactionResult } from "./result-builder.js";
import { feeSlots, resolveFee } from "./tx/fee.js";
import { changeSlots, finalizeSlots, payTo } from "./tx/outputs.js";
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

    // Rejected here rather than proved: a zero-value output is a self-pad that
    // every scanner discards, so the spend would cost a proof and a fee to
    // deliver a note the payee can never see.
    if (sendValue <= 0n) {
        throw new InvalidArgumentError(`transfer: amount must be positive, got ${sendValue}`, {
            argument: "amount",
        });
    }

    // Decoded here rather than below `prepareSpend`, where the recipient is
    // first needed. It is a pure check on caller input; running it after
    // selection would report a typo'd address only after the wallet had picked
    // cover, possibly auto-consolidated (a self-spend plus a cooldown wait),
    // synced and verified the tree, and built input slots.
    const recipient = decodeAddress(ctx.J, args.to);

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
    const changeValue = branded<CircuitAmount>(selection.sum - covered);

    const sendNote: Note = {
        asset,
        value: sendValue,
        pk: recipient.pk,
        ...freshNoteRandomness(),
    };

    // One slot pays the recipient, the fee takes what it needs, and the rest is
    // change back to self. Roles ride on the slots rather than on their
    // positions, because `finalizeSlots` shuffles them — see `tx/outputs.ts`.
    //
    // `own` is compared on the decoded `pk`, not on the address string: bech32m
    // permits an all-uppercase spelling and a re-encode is not guaranteed
    // byte-identical either, so a string compare would read as "not self" and
    // under-report a note the caller does own. On a self-transfer the payee slot
    // is ours as well.
    const {
        args: outputs,
        ownIndices,
        payeeIndex,
    } = finalizeSlots([
        { ...payTo(sendNote, recipient, recipient.pk === ctx.keys.pk), payee: true },
        ...changeSlots(
            ctx.keys.pk,
            ownAddr,
            asset,
            changeValue,
            ctx.cfg.shape.nOut - 1 - (fee?.slots ?? 0),
        ),
        ...feeSlots(fee, feeSelection, ctx.keys.pk, ownAddr),
    ]);

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
        ...outputs,
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
        ownIndices,
        payeeIndex,
    });
}
