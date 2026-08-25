// Withdraw transaction logic. Backs `Wallet.withdraw` / `Wallet.withdrawEth`;
// the `kind` discriminator routes between the ERC-20 and native-ETH builders.

import { buildSpend } from "../bundle/spend.js";
import { branded, type CircuitAmount } from "../core/brand.js";
import { safePhase } from "../core/callbacks.js";
import { WalletConfigError } from "../core/errors.js";
import { applyFee } from "../core/fees.js";
import { resolveAmount } from "./amount.js";
import type { WithdrawOptions, WithdrawResult } from "./api.js";
import type { AssetRef } from "./asset-ref.js";
import type { SpendContext } from "./context.js";
import { makeTransactionResult } from "./result-builder.js";
import { feeSlots, resolveFee } from "./tx/fee.js";
import { changeSlots, ownIndices, spendOutputs } from "./tx/outputs.js";
import { prepareSpend, submitSpend } from "./tx/steps.js";

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
    args: WithdrawOptions & { asset: AssetRef },
    kind: WithdrawKind,
): Promise<WithdrawResult> {
    // Resolve at the boundary; below here everything is ids and circuit units.
    const info = await ctx.resolveAsset(args.asset);
    const asset = info.id;
    const amount = resolveAmount(args.amount, info);
    const feeBps = await ctx.feeBps();
    // The protocol fee is skimmed on chain from the amount leaving the pool;
    // the relayer's fee below is a separate charge, paid as a shielded note.
    const protocolFee = applyFee(amount, feeBps);
    const publicOut = branded<CircuitAmount>(amount + protocolFee);

    const feeAsset =
        args.feeAsset === undefined ? undefined : (await ctx.resolveAsset(args.feeAsset)).id;
    const relayerFee = await resolveFee(ctx, { kind, spendAsset: asset, feeAsset });

    const { selection, feeSelection, ownAddr, inputs, merkleRoot, spentIds, covered } =
        await prepareSpend(ctx, {
            asset,
            target: publicOut,
            fee: relayerFee,
            selectOpts: args.selectOpts,
            autoConsolidate: args.autoConsolidate,
            onPhase: args.onPhase,
        });

    const remainder = branded<CircuitAmount>(selection.sum - covered);
    // Every slot the fee does not need is change back to self.
    const slots = [
        ...changeSlots(
            ctx.keys.pk,
            ownAddr,
            asset,
            remainder,
            ctx.cfg.shape.nOut - (relayerFee?.slots ?? 0),
        ),
        ...feeSlots(relayerFee, feeSelection, ctx.keys.pk, ownAddr),
    ];

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
        shape: ctx.cfg.shape,
        inputs,
        merkleRoot,
        publicOut,
        ...spendOutputs(slots),
    });

    safePhase(args.onPhase, "submitting");
    const spent = spentIds;
    const { txHash } = await submitSpend(ctx, spent, () => ctx.submitter.submit(built.payload));
    return makeTransactionResult({
        kind: "withdraw",
        txHash,
        built,
        spent,
        inputSum: selection.sum,
        sent: publicOut,
        change: remainder,
        ownIndices: ownIndices(slots),
    });
}
