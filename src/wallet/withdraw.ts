// Withdraw transaction logic. Backs `Wallet.withdraw` / `Wallet.withdrawEth`;
// the `kind` discriminator routes between the ERC-20 and native-ETH builders.

import { buildSpend } from "../bundle/spend.js";
import { assetId, branded, type CircuitAmount } from "../core/brand.js";
import { safePhase } from "../core/callbacks.js";
import { WalletConfigError } from "../core/errors.js";
import { applyFee } from "../core/fees.js";
import { freshOutputAuxRandomness } from "../notes/randomness.js";
import type { WithdrawOptions, WithdrawResult } from "./api.js";
import type { SpendContext } from "./context.js";
import { makeTransactionResult } from "./internal.js";
import { prepareSpend, splitChange } from "./tx/steps.js";

export type WithdrawKind = "withdraw" | "withdrawNative";

/**
 * The `NativeAdapter` address, which a native unshield is bound to. Fails
 * before proving: a proof naming anyone else is unusable, and discovering
 * that from an on-chain revert costs a full Groth16 first.
 */
function requireNativeAdapter(ctx: SpendContext): string {
    const adapter = ctx.cfg.chain.nativeAdapterAddress?.();
    if (!adapter) {
        throw new WalletConfigError(
            "nativeAdapterAddress is required for withdrawEth: the MASP pool is ERC-20 only, so the unwrap runs through NativeAdapter",
        );
    }
    return adapter;
}

export async function executeWithdraw(
    ctx: SpendContext,
    args: WithdrawOptions & { asset: bigint },
    kind: WithdrawKind,
): Promise<WithdrawResult> {
    // Brand at the boundary; `assetId` enforces the uint64 range.
    const asset = assetId(args.asset);
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

    // Who the proof names depends on which contract will call the pool.
    //
    // An ERC-20 unshield is submitted by the relayer, which pushes the token
    // straight to `args.to`. A native one is submitted by `NativeAdapter`:
    // the pool checks `pi.relayer == msg.sender`, and the adapter needs the
    // WETH to land on itself so it can unwrap — so it is both `relayer` and
    // `recipient`, and it forwards the raw ETH to `pi.payer`. Naming the
    // relayer here reverts `AdapterNotRelayer`, and naming `args.to` as
    // recipient reverts `AdapterNotRecipient`.
    const binding =
        kind === "withdrawNative"
            ? {
                  payer: args.to,
                  relayer: requireNativeAdapter(ctx),
                  recipient: requireNativeAdapter(ctx),
              }
            : {
                  payer: ctx.cfg.relayerAddress,
                  relayer: ctx.cfg.relayerAddress,
                  recipient: args.to,
              };

    safePhase(args.onPhase, "proving");
    const built = await buildSpend({
        kind,
        P: ctx.P,
        J: ctx.J,
        chainId: ctx.cfg.chainId,
        asset,
        payerAddress: binding.payer,
        relayerAddress: binding.relayer,
        recipientAddress: binding.recipient,
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
