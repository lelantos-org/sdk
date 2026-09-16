// Shielded transfer, as a spend spec. Backs `wallet.transfer`.

import { freshNoteRandomness } from "../../notes/randomness.js";
import { precheckAmount, requirePositive, resolveAmount, shieldedMoney } from "../assets/amount.js";
import type { WalletContext } from "../context.js";
import { payTo } from "../tx/outputs.js";
import { shieldedRecipient } from "../tx/recipient.js";
import { detachedRun, landedBase, runSpend, type SpendRun } from "../tx/run-spend.js";
import type { TransferOptions } from "../types/options.js";
import type { TransferResult } from "../types/results.js";

export function executeTransfer(
    ctx: WalletContext,
    args: TransferOptions,
    run: SpendRun = detachedRun("transfer"),
): Promise<TransferResult> {
    return runSpend(
        ctx,
        {
            options: args,
            async plan(ctx) {
                precheckAmount(args.amount, "amount", "transfer");
                // Decoded before selection, so an invalid address fails before auto-consolidation,
                // tree sync and input construction.
                const { address, decoded: recipient } = shieldedRecipient(
                    ctx.J,
                    args.recipient,
                    "transfer",
                );
                // Verified: scale converts a human amount and the ladder splits change.
                const asset = await ctx.assets.resolveVerified(args.asset);
                const target = resolveAmount(args.amount, asset);
                // A zero-value output is padding that every scanner discards, so the payee would
                // never see the note.
                requirePositive(target, "amount", "transfer");
                return {
                    feeKind: "transfer" as const,
                    asset,
                    target,
                    recipient,
                    recipientAddress: address,
                };
            },
            // Ownership compares the decoded `pk`, not the address string: bech32m permits an
            // uppercase spelling and re-encoding is not guaranteed byte-identical. On a
            // self-transfer the payee slot is also owned.
            outputs: (ctx, { asset, target, recipient }) => [
                {
                    ...payTo(
                        {
                            asset: asset.id,
                            value: target,
                            pk: recipient.pk,
                            ...freshNoteRandomness(),
                        },
                        recipient,
                        recipient.pk === ctx.keys.pk,
                    ),
                    payee: true,
                },
            ],
            bind: (ctx) => {
                const relayer = ctx.cfg.relayerAddress;
                return { kind: "transfer", payer: relayer, relayer, recipient: relayer };
            },
            result: (_ctx, { asset, target, recipientAddress }, landed): TransferResult => ({
                kind: "transfer",
                ...landedBase(landed, asset),
                fees: Object.freeze({ protocol: null, relayer: landed.relayerFee }),
                amount: shieldedMoney(asset, target),
                recipient: recipientAddress,
                // `target` is positive, so the payee's slot always exists and carries value.
                recipientCommitment: landed.payeeCommitment!,
                spent: landed.spent,
                change: landed.change,
            }),
        },
        run,
    );
}
