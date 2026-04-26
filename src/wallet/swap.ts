// Atomic shielded swap logic. Backs `Wallet.swap`.

import { buildDeposit } from "../bundle/deposit.js";
import { buildSpend } from "../bundle/spend.js";
import { safePhase } from "../core/callbacks.js";
import { InvalidArgumentError, WalletConfigError } from "../core/errors.js";
import { applyFee, assertPublicInFits, BPS_DENOMINATOR } from "../core/fees.js";
import { decodeAddress } from "../keys/address.js";
import { freshOutputAuxRandomness } from "../notes/randomness.js";
import { auxOutputFromWire } from "../protocol/aux-wire.js";
import type { SubmitSwapPayload } from "../protocol/transact.js";
import type { SwapOptions, SwapResult } from "./api.js";
import type { SpendContext } from "./context.js";
import { makeTransactionResult } from "./internal.js";
import { freshDepositSlots, prepareSpend, splitChangePair } from "./tx/steps.js";

export async function executeSwap(ctx: SpendContext, args: SwapOptions): Promise<SwapResult> {
    if (!ctx.submitter.submitSwap) {
        throw new WalletConfigError(
            "swap requires a submitter implementing submitSwap; the configured " +
                "submitter does not",
        );
    }
    if (args.assetIn === args.assetOut) {
        throw new InvalidArgumentError("swap: assetIn must differ from assetOut", {
            argument: "assetOut",
        });
    }

    const { assetIn, assetOut, quote, wrapperAddress } = args;
    const feeBps = await ctx.feeBps();
    const fee = applyFee(args.amount, feeBps);
    const publicOut = args.amount + fee;

    const { selection, ownAddr, inputs, merkleRoot } = await prepareSpend(ctx, {
        asset: assetIn,
        target: publicOut,
        selectOpts: args.selectOpts,
        autoConsolidate: args.autoConsolidate,
        onPhase: args.onPhase,
    });
    const bRecipient = decodeAddress(ctx.J, args.bRecipient ?? ctx.address);

    const remainder = selection.sum - publicOut;
    const [change0, change1] = splitChangePair(ctx.keys.pk, assetIn, remainder);

    const [entryIn, entryOut] = await Promise.all([
        ctx.cfg.chain.fetchAsset(assetIn),
        ctx.cfg.chain.fetchAsset(assetOut),
    ]);

    // B-note value bounded so the wrapper covers the Permit2 pull:
    // `bValue * scaleOut * (10_000 + feeBps) / 10_000 ≤ minOut`.
    // Floor-div remainder becomes wrapper-side dust to treasury.
    const bValue = (quote.minOut * BPS_DENOMINATOR) / (entryOut.scale * (BPS_DENOMINATOR + feeBps));
    if (bValue <= 0n) {
        throw new InvalidArgumentError(
            `swap: minOut ${quote.minOut} below scaleOut*(1+fee) (zero B-note)`,
            { argument: "minOut" },
        );
    }
    assertPublicInFits(bValue, {
        what: "swap B-note publicIn",
        asset: assetOut,
        scale: entryOut.scale,
    });

    safePhase(args.onPhase, "proving");
    // Leg 1: withdraw → wrapper. MASP enforces `pi.relayer == msg.sender`.
    const built = await buildSpend({
        kind: "withdraw",
        P: ctx.P,
        J: ctx.J,
        chainId: ctx.cfg.chainId,
        asset: assetIn,
        payerAddress: wrapperAddress,
        relayerAddress: wrapperAddress,
        recipientAddress: wrapperAddress,
        prover: ctx.prover,
        treeDepth: ctx.cfg.treeDepth,
        inputs,
        merkleRoot,
        publicOut,
        outputs: [change0, change1],
        outputRecipients: [ownAddr, ownAddr],
        outputRandomness: [freshOutputAuxRandomness(), freshOutputAuxRandomness()],
    });

    // Leg 2: B-note deposit intent. Slot 0 = real B note, slot 1 = pad.
    const { output0: o0, output1Pad: o1 } = freshDepositSlots();
    const intentBundle = buildDeposit({
        P: ctx.P,
        J: ctx.J,
        chainId: ctx.cfg.chainId,
        asset: assetOut,
        payerAddress: wrapperAddress,
        recipientAddress: wrapperAddress,
        publicIn: bValue,
        recipient: bRecipient,
        output0: {
            rho: o0.rho,
            rcm: o0.rcm,
            rcv: o0.rcv,
            rcvDep: o0.rcvDep,
            aux: o0.aux,
        },
        output1Pad: {
            rho: o1.rho,
            rcm: o1.rcm,
            rcv: o1.rcv,
            rcvDep: o1.rcvDep,
        },
    });

    // MASP skims fee off gross before transferring to wrapper.
    const grossIn = publicOut * entryIn.scale;
    const feeIn = applyFee(grossIn, feeBps);
    const amountInUnits = grossIn - feeIn;

    const payload: SubmitSwapPayload = {
        chainId: ctx.cfg.chainId,
        proof2x2: built.payload.proof2x2,
        pubInputs: built.payload.pubInputs,
        aux: built.payload.aux,
        swap: {
            adapter: quote.adapter,
            route: quote.route,
            intentD: intentBundle.intent,
            auxD: [auxOutputFromWire(intentBundle.aux[0]), auxOutputFromWire(intentBundle.aux[1])],
            tokenIn: entryIn.token,
            tokenOut: entryOut.token,
            amountIn: amountInUnits,
            minOut: quote.minOut,
        },
    };

    safePhase(args.onPhase, "submitting");
    const { txHash } = await ctx.submitter.submitSwap(payload);
    const spent = selection.notes.map((n) => n.id);
    await ctx.markSpent(spent);

    // B note materialises asynchronously via the relayer's flushBatch;
    // only leg-1 change commitments surface here.
    return makeTransactionResult({
        kind: "swap",
        txHash,
        built,
        spent,
        inputSum: selection.sum,
        sent: publicOut,
        change: remainder,
        ownIndices: [0, 1],
    });
}
