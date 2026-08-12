// Withdraw transaction logic. Backs `Wallet.withdraw` / `Wallet.withdrawEth`;
// the `kind` discriminator routes between the ERC-20 and native-ETH builders.

import { buildSpend } from "../bundle/spend.js";
import { branded, type CircuitAmount } from "../core/brand.js";
import { safePhase } from "../core/callbacks.js";
import { applyFee } from "../core/fees.js";
import { freshOutputAuxRandomness } from "../notes/randomness.js";
import type { WithdrawOptions, WithdrawResult } from "./api.js";
import type { SpendContext } from "./context.js";
import { makeTransactionResult } from "./internal.js";
import { prepareSpend, splitChange } from "./tx/steps.js";

export type WithdrawKind = "withdraw" | "withdrawNative";

export async function executeWithdraw(
    ctx: SpendContext,
    args: WithdrawOptions & { asset: bigint },
    kind: WithdrawKind,
): Promise<WithdrawResult> {
    const { asset } = args;
    const feeBps = await ctx.feeBps();
    const fee = applyFee(args.amount, feeBps);
    const publicOut = branded<CircuitAmount>(args.amount + fee);

    const { selection, ownAddr, inputs, merkleRoot } = await prepareSpend(ctx, {
        asset,
        target: publicOut,
        selectOpts: args.selectOpts,
        autoConsolidate: args.autoConsolidate,
        onPhase: args.onPhase,
    });

    const remainder = branded<CircuitAmount>(selection.sum - publicOut);
    // All output slots are change back to self.
    const nOut = ctx.cfg.shape.nOut;
    const change = splitChange(ctx.keys.pk, asset, remainder, nOut);

    safePhase(args.onPhase, "proving");
    const built = await buildSpend({
        kind,
        P: ctx.P,
        J: ctx.J,
        chainId: ctx.cfg.chainId,
        asset,
        payerAddress: ctx.cfg.relayerAddress,
        relayerAddress: ctx.cfg.relayerAddress,
        recipientAddress: args.to,
        prover: ctx.prover,
        treeDepth: ctx.cfg.treeDepth,
        inputs,
        merkleRoot,
        publicOut,
        outputs: change,
        outputRecipients: change.map(() => ownAddr),
        outputRandomness: change.map(() => freshOutputAuxRandomness()),
    });

    safePhase(args.onPhase, "submitting");
    const { txHash } = await ctx.submitter.submit(built.payload);
    const spent = selection.notes.map((n) => n.id);
    await ctx.markSpent(spent);
    return makeTransactionResult({
        kind: "withdraw",
        txHash,
        built,
        spent,
        inputSum: selection.sum,
        sent: publicOut,
        change: remainder,
        // Every output slot is change-to-self.
        ownIndices: change.map((_, i) => i),
    });
}
