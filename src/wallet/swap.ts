// Atomic shielded swap logic. Backs `Wallet.swap`.

import { buildDeposit } from "../bundle/deposit.js";
import { buildSpend } from "../bundle/spend.js";
import { assetId, branded, type CircuitAmount, evmAddress } from "../core/brand.js";
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
import { freshDepositSlots, prepareSpend, splitChange } from "./tx/steps.js";

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

    // Brand at the boundary; the constructors validate as they brand.
    const assetIn = assetId(args.assetIn);
    const assetOut = assetId(args.assetOut);
    const wrapperAddress = evmAddress(args.wrapperAddress);
    const { quote } = args;
    const feeBps = await ctx.feeBps();
    const fee = applyFee(args.amount, feeBps);
    const publicOut = branded<CircuitAmount>(args.amount + fee);

    const { selection, ownAddr, inputs, merkleRoot } = await prepareSpend(ctx, {
        asset: assetIn,
        target: publicOut,
        selectOpts: args.selectOpts,
        autoConsolidate: args.autoConsolidate,
        onPhase: args.onPhase,
    });
    const bRecipient = decodeAddress(ctx.J, args.bRecipient ?? ctx.address);

    const remainder = branded<CircuitAmount>(selection.sum - publicOut);
    // All output slots are change back to self.
    const nOut = ctx.cfg.shape.nOut;
    const change = splitChange(ctx.keys.pk, assetIn, remainder, nOut);

    const [entryIn, entryOut] = await Promise.all([
        ctx.cfg.chain.fetchAsset(assetIn),
        ctx.cfg.chain.fetchAsset(assetOut),
    ]);

    const bValue = sizeBNote(quote.minOut, entryOut.scale, feeBps);
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
    // Leg 1: withdraw → wrapper.
    //
    // `relayer` and `recipient` are the wrapper: it is the contract that calls
    // `MASP.withdraw`, so it is the pool's `msg.sender` (which the pool pins
    // via `pi.relayer == msg.sender`) and the address the tokens must land on.
    //
    // `payer` is different — the wrapper reads it as *who may drive this
    // swap*. `swap` is permissionless and `deposit_d` is unauthenticated
    // calldata, so without that check this withdraw proof could be replayed
    // out of the mempool under a different deposit, redirecting the output
    // note. It therefore names the account that submits the swap, which is
    // the relayer; naming the wrapper reverts `UnauthorizedSwapCaller`.
    const built = await buildSpend({
        kind: "withdraw",
        P: ctx.P,
        J: ctx.J,
        chainId: ctx.cfg.chainId,
        asset: assetIn,
        payerAddress: ctx.cfg.relayerAddress,
        relayerAddress: wrapperAddress,
        recipientAddress: wrapperAddress,
        prover: ctx.prover,
        treeDepth: ctx.cfg.treeDepth,
        inputs,
        merkleRoot,
        publicOut,
        outputs: change,
        outputRecipients: change.map(() => ownAddr),
        outputRandomness: change.map(() => freshOutputAuxRandomness()),
    });

    // Leg 2: B-note deposit. One leaf, so there is no pad slot.
    const { output0: o0 } = freshDepositSlots();
    const depositBundle = buildDeposit({
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
    });

    // MASP skims fee off gross before transferring to wrapper.
    const grossIn = publicOut * entryIn.scale;
    const feeIn = applyFee(grossIn, feeBps);
    const amountInUnits = grossIn - feeIn;

    const payload: SubmitSwapPayload = {
        chainId: ctx.cfg.chainId,
        proof: built.payload.proof,
        pubInputs: built.payload.pubInputs,
        aux: built.payload.aux,
        swap: {
            adapter: quote.adapter,
            route: quote.route,
            depositD: depositBundle.deposit,
            auxD: auxOutputFromWire(depositBundle.aux),
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
        ownIndices: change.map((_, i) => i),
    });
}

/**
 * Smallest B-note value whose on-chain Permit2 pull covers `minOut`.
 *
 * The wrapper enforces a window, not a ceiling: `minOut ≤ pulled ≤ actualOut`,
 * as `MaspPullBelowMinOut` and `MaspPullExceedsActualOut`. Solving only the
 * upper bound — the closed form `minOut * BPS / (scale * (BPS + feeBps))` —
 * lands *below* `minOut` whenever the division is inexact, and reverts.
 *
 * `pulled` is principal plus fee, and the pool floors the fee, so it advances
 * in steps no closed form always hits. Start from the floor-div estimate (a
 * lower bound) and walk up. Minimality is what keeps the answer under
 * `actualOut`; any overshoot is wrapper-side dust forwarded to the treasury.
 *
 * @internal
 */
export function sizeBNote(minOut: bigint, scaleOut: bigint, feeBps: bigint): bigint {
    const pullFor = (v: bigint): bigint => {
        const inAmt = v * scaleOut;
        return inAmt + applyFee(inAmt, feeBps);
    };
    let v = (minOut * BPS_DENOMINATOR) / (scaleOut * (BPS_DENOMINATOR + feeBps));
    // `pullFor` is strictly increasing in `v`, so this terminates.
    while (pullFor(v) < minOut) v += 1n;
    return v;
}
