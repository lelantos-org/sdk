// Atomic shielded swap logic. Backs `Wallet.swap`.

import { buildDeposit } from "../bundle/deposit.js";
import { buildSpend } from "../bundle/spend.js";
import { branded, type CircuitAmount, evmAddress } from "../core/brand.js";
import { safePhase } from "../core/callbacks.js";
import { InvalidArgumentError, WalletConfigError } from "../core/errors.js";
import { applyFee, assertPublicInFits, BPS_DENOMINATOR } from "../core/fees.js";
import { decodeAddress } from "../keys/address.js";
import { auxOutputFromWire } from "../protocol/aux-wire.js";
import type { SubmitSwapPayload } from "../protocol/transact.js";
import { resolveAmount } from "./amount.js";
import type { SwapOptions, SwapResult } from "./api.js";
import type { SpendContext } from "./context.js";
import { makeTransactionResult } from "./result-builder.js";
import { resolveDepositFee } from "./tx/deposit-fee.js";
import { feeSlots, resolveFee } from "./tx/fee.js";
import { changeSlots, finalizeSlots } from "./tx/outputs.js";
import { freshDepositSlots, prepareSpend, submitSpend } from "./tx/steps.js";

export async function executeSwap(ctx: SpendContext, args: SwapOptions): Promise<SwapResult> {
    // Bound here rather than read at the call site: `submitSwap` is optional
    // on `Submitter`, and the narrowing this check gives does not survive into
    // the closure that submits.
    const submitSwap = ctx.submitter.submitSwap?.bind(ctx.submitter);
    if (!submitSwap) {
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
    // Checked with the other argument validation rather than below
    // `prepareSpend`, where the B-note recipient is first used: a malformed
    // `bRecipient` is caller input, and deferring it charged a full selection,
    // a possible auto-consolidate, and a tree sync before saying so.
    const bRecipientAddress = args.bRecipient ?? ctx.address;
    const bRecipient = decodeAddress(ctx.J, bRecipientAddress);

    // Resolve at the boundary; the constructors validate as they brand.
    const infoIn = await ctx.resolveAsset(args.assetIn);
    const assetIn = infoIn.id;
    const assetOut = (await ctx.resolveAsset(args.assetOut)).id;
    const amount = resolveAmount(args.amount, infoIn);
    const wrapperAddress = evmAddress(args.wrapperAddress);
    const { quote } = args;
    const feeBps = await ctx.feeBps();
    const protocolFee = applyFee(amount, feeBps);
    const publicOut = branded<CircuitAmount>(amount + protocolFee);

    // The relayer's fee rides on leg 1, which is the only leg that spends
    // shielded notes. Quoted as a swap: its gas covers both legs plus the
    // on-chain swap, so a spend estimate would under-quote it.
    const feeAsset =
        args.feeAsset === undefined ? undefined : (await ctx.resolveAsset(args.feeAsset)).id;
    const relayerFee = await resolveFee(ctx, { kind: "swap", spendAsset: assetIn, feeAsset });

    const { selection, feeSelection, ownAddr, inputs, merkleRoot, spentIds, covered } =
        await prepareSpend(ctx, {
            asset: assetIn,
            target: publicOut,
            fee: relayerFee,
            selectOpts: args.selectOpts,
            autoConsolidate: args.autoConsolidate,
            onPhase: args.onPhase,
        });

    const remainder = branded<CircuitAmount>(selection.sum - covered);
    // Every slot the fee does not need is change back to self. `finalizeSlots`
    // shuffles them, so the fee is at no fixed index — see `tx/outputs.ts`.
    const { args: outputs, ownIndices } = finalizeSlots([
        ...changeSlots({
            pk: ctx.keys.pk,
            ownAddr,
            asset: assetIn,
            remainder,
            slots: ctx.cfg.shape.nOut - (relayerFee?.slots ?? 0),
            ladder: infoIn.ladder,
        }),
        ...feeSlots(relayerFee, feeSelection, ctx.keys.pk, ownAddr),
    ]);

    const [entryIn, entryOut] = await Promise.all([
        ctx.cfg.chain.fetchAsset(assetIn),
        ctx.cfg.chain.fetchAsset(assetOut),
    ]);

    // The B-note deposit is flushed later, by a relayer, and that flush is not
    // covered by leg 1's fee — leg 1 pays `EntryPoint::Swap` (relaying this
    // transaction), while the flush is priced separately per deposit. Left
    // unpaid, the deposit is escrowed and then skipped forever with "fee note
    // is not addressed to this relayer", and the B-note never materialises.
    //
    // Resolved against the *out* asset, because that is what the deposit mints
    // and a payer can only pay in the asset being deposited.
    const bFee = await resolveDepositFee(ctx, {
        asset: assetOut,
        recipient: bRecipientAddress,
    });

    const bValue = sizeBNote(quote.minOut, entryOut.scale, feeBps, bFee.value);
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
        shape: ctx.cfg.shape,
        inputs,
        merkleRoot,
        publicOut,
        ...outputs,
    });

    // Leg 2: B-note deposit. One leaf, so there is no pad slot.
    const { output0: o0, fee: feeSlot } = freshDepositSlots();
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
        // Pays for the flush that commits this deposit. Funded from the swap's
        // own output — `sizeBNote` sized `publicIn` to leave room in the same
        // Permit2 pull — so it is not a second charge to the user. Zero on a
        // chain that subsidises deposits, where it is a pad addressed to the
        // B-note recipient.
        fee: {
            recipient: bFee.recipient,
            value: bFee.value,
            rho: feeSlot.rho,
            rcm: feeSlot.rcm,
            rcv: feeSlot.rcv,
            rcvDep: feeSlot.rcvDep,
            aux: feeSlot.aux,
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
            feeAuxD: auxOutputFromWire(depositBundle.feeAux),
            tokenIn: entryIn.token,
            tokenOut: entryOut.token,
            amountIn: amountInUnits,
            minOut: quote.minOut,
        },
    };

    safePhase(args.onPhase, "submitting");
    const spent = spentIds;
    const { txHash } = await submitSpend(ctx, spent, () => submitSwap(payload));

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
        ownIndices,
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
 * `pulled` is principal, the pool's fee, and the note paying whoever flushes
 * the deposit — and the pool floors its fee, so the pull advances in steps no
 * closed form always hits. Start from the floor-div estimate and walk to the
 * smallest `v` that still covers `minOut`. Minimality is what keeps the answer
 * under `actualOut`; any overshoot is wrapper-side dust forwarded to the
 * treasury.
 *
 * `relayerFee` is in circuit units of the *out* asset and rides in the same
 * pull, so a non-zero one makes the B-note smaller: the flush is paid for out
 * of the swap's own output rather than by a second charge to the user.
 *
 * Public because it is the only correct answer to "how much will this swap
 * credit me?", and that is a question every caller showing a quote has to
 * answer before the user commits. `executeSwap` encodes this exact value as
 * the deposit leg's `publicIn`, so it is what the wallet receives — not a
 * floor, since the wrapper pulls only what the B-note needs and forwards any
 * better-than-quoted fill to the treasury. Callers that derive it themselves
 * reach for the closed form above and get a figure that is both wrong on
 * screen and, if used to size a transaction, reverting on chain.
 */
export function sizeBNote(
    minOut: bigint,
    scaleOut: bigint,
    feeBps: bigint,
    relayerFee: bigint = 0n,
): bigint {
    const pullFor = (v: bigint): bigint => {
        const inAmt = v * scaleOut;
        return inAmt + applyFee(inAmt, feeBps) + relayerFee * scaleOut;
    };
    let v = (minOut * BPS_DENOMINATOR) / (scaleOut * (BPS_DENOMINATOR + feeBps));
    // Guard the floor-div estimate: with a relayer fee the pull can already
    // cover `minOut` at a smaller `v`, and the walk below only moves up.
    while (v > 0n && pullFor(v - 1n) >= minOut) v -= 1n;
    // `pullFor` is strictly increasing in `v`, so this terminates.
    while (pullFor(v) < minOut) v += 1n;
    return v;
}
