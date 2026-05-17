// Atomic shielded swap logic, extracted from `Wallet.swap`.

import { buildDeposit } from "../bundle/deposit.js";
import { buildWithdraw } from "../bundle/withdraw.js";
import { decodeAddress } from "../keys/address.js";
import type { Note } from "../notes/note.js";
import { freshNoteRandomness, freshOutput, freshOutputAuxRandomness } from "../notes/randomness.js";
import type { SubmitSwapPayload } from "../relayer/client.js";
import type { SwapOptions, TransactionResult } from "./api.js";
import { BPS_DENOMINATOR, PUBLIC_IN_MAX } from "./constants.js";
import { ensureCover } from "./cover.js";
import { buildInputSlots } from "./inputs.js";
import { auxOutputToTransactAux, makeTransactionResult } from "./internal.js";
import type { Wallet } from "./wallet.js";
import { safePhase } from "./wallet.js";

export async function executeSwap(wallet: Wallet, args: SwapOptions): Promise<TransactionResult> {
    if (!wallet.submitter.submitSwap) {
        throw new Error("swap: submitter does not implement submitSwap");
    }
    if (args.assetIn === args.assetOut) {
        throw new Error("swap: assetIn must differ from assetOut");
    }

    const { assetIn, assetOut, quote, wrapperAddress } = args;
    const feeBps = await wallet.resolveFeeBps();
    const fee = (args.amount * feeBps) / BPS_DENOMINATOR;
    const publicOut = args.amount + fee;

    safePhase(args.onPhase, "preparing");
    const selection = await ensureCover(
        wallet.selector,
        () => wallet.file.notes,
        {
            asset: assetIn,
            target: publicOut,
            selectOpts: args.selectOpts,
            autoConsolidate: args.autoConsolidate,
        },
        (a, sel) => wallet.autoConsolidate(a, sel),
    );

    const ownAddr = decodeAddress(wallet.J, wallet.address);
    const bRecipient = decodeAddress(wallet.J, args.bRecipient ?? wallet.address);
    const inputs = await buildInputSlots(wallet.inputsCtx(), selection.notes, assetIn);

    const remainder = selection.sum - publicOut;
    const half = remainder / 2n;
    const change0: Note = {
        asset: assetIn,
        value: half,
        pk: wallet.keys.pk,
        ...freshNoteRandomness(),
    };
    const change1: Note = {
        asset: assetIn,
        value: remainder - half,
        pk: wallet.keys.pk,
        ...freshNoteRandomness(),
    };

    const merkleRoot = (await wallet.noteSource.fetchPath(selection.notes[0].cm)).root;

    const [entryIn, entryOut] = await Promise.all([
        wallet.cfg.chain.fetchAsset(assetIn),
        wallet.cfg.chain.fetchAsset(assetOut),
    ]);

    // B-note value bounded so the wrapper covers the Permit2 pull:
    // `bValue * scaleOut * (10_000 + feeBps) / 10_000 ≤ minOut`.
    // Floor-div remainder becomes wrapper-side dust to treasury.
    const bValue = (quote.minOut * BPS_DENOMINATOR) / (entryOut.scale * (BPS_DENOMINATOR + feeBps));
    if (bValue <= 0n) {
        throw new Error(`swap: minOut ${quote.minOut} below scaleOut*(1+fee) (zero B-note)`);
    }
    if (bValue > PUBLIC_IN_MAX) {
        throw new Error(
            `swap: publicIn ${bValue} exceeds uint48 cap; asset ${assetOut} scale ${entryOut.scale} too small for minOut ${quote.minOut}`,
        );
    }

    safePhase(args.onPhase, "proving");
    // Leg 1: withdraw → wrapper. MASP enforces `pi.relayer == msg.sender`.
    const built = await buildWithdraw({
        P: wallet.P,
        J: wallet.J,
        chainId: wallet.cfg.chainId,
        asset: assetIn,
        payerAddress: wrapperAddress,
        relayerAddress: wrapperAddress,
        recipientAddress: wrapperAddress,
        prover: wallet.prover,
        treeDepth: wallet.cfg.treeDepth,
        inputs,
        merkleRoot,
        publicOut,
        change: [change0, change1],
        changeRecipients: [ownAddr, ownAddr],
        changeRandomness: [freshOutputAuxRandomness(), freshOutputAuxRandomness()],
    });

    // Leg 2: B-note deposit intent. Slot 0 = real B note, slot 1 = pad.
    const o0 = freshOutput();
    const o1 = freshNoteRandomness();
    const intentBundle = buildDeposit({
        P: wallet.P,
        J: wallet.J,
        chainId: wallet.cfg.chainId,
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
    const feeIn = (grossIn * feeBps) / BPS_DENOMINATOR;
    const amountInUnits = grossIn - feeIn;

    const payload: SubmitSwapPayload = {
        chainId: wallet.cfg.chainId,
        proof2x2: built.payload.proof2x2,
        pubInputs: built.payload.pubInputs,
        aux: built.payload.aux,
        swap: {
            adapter: quote.adapter,
            route: quote.route,
            intentD: intentBundle.intent,
            auxD: [
                auxOutputToTransactAux(intentBundle.aux[0]),
                auxOutputToTransactAux(intentBundle.aux[1]),
            ],
            tokenIn: entryIn.token,
            tokenOut: entryOut.token,
            amountIn: amountInUnits,
            minOut: quote.minOut,
        },
    };

    safePhase(args.onPhase, "submitting");
    const { txHash } = await wallet.submitter.submitSwap(payload);
    const spent = selection.notes.map((n) => n.id);
    await wallet.markSpent(spent);

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
