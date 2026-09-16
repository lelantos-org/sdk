// Atomic shielded swap, as a spend spec. Backs `wallet.swap`.
//
// Leg 1 is a withdraw of `assetIn` to `SwapWrapper`; leg 2 is a deposit request the wrapper
// escrows (`./swap-escrow.ts`). Both are bundled via `submitter.submitSwap`.
//
// The quote is never trusted: both assets are re-resolved, and gross, net and both note values are
// recomputed from `quote.side` with the functions `quoteSwap` used (`tx/swap-terms.ts`). A quote
// they would not reproduce is refused, so what is proven is what the caller was shown.

import type { BuiltDeposit } from "../../bundle/deposit.js";
import { circuitAmount } from "../../core/brand.js";
import { fieldToBytes32 } from "../../core/hex.js";
import { UnsupportedOperationError } from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { QuoteStaleError } from "../../errors/spend.js";
import { swapIntentHash } from "../../protocol/abi-hash.js";
import { auxOutputFromWire } from "../../protocol/aux-wire.js";
import { isDenomination } from "../../protocol/denominations.js";
import type { SubmitSwapPayload, SwapBlob } from "../../protocol/transact.js";
import { publicMoney, resolveOutAmount, shieldedMoney } from "../assets/amount.js";
import type { AssetInfo } from "../assets/info.js";
import type { WalletContext } from "../context.js";
import { resolveSwapDeadline } from "../tx/deadline.js";
import { shieldedRecipient } from "../tx/recipient.js";
import { detachedRun, landedBase, runSpend, type SpendRun } from "../tx/run-spend.js";
import {
    type CheckedQuote,
    quoteInconsistency,
    resolveSwapAssets,
    resolveSwapWrapper,
    type SwapLegs,
    swapFees,
    swapLegs,
} from "../tx/swap-terms.js";
import type { SwapOptions } from "../types/options.js";
import type { SwapQuote } from "../types/quotes.js";
import type { SwapResult } from "../types/results.js";
import { buildSwapEscrows, resolveRefundAddress } from "./swap-escrow.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BLOB = /^0x([0-9a-fA-F]{2})*$/;

export function executeSwap(
    ctx: WalletContext,
    args: SwapOptions,
    run: SpendRun = detachedRun("swap"),
): Promise<SwapResult> {
    // Filled in by `bind`, read by `result`.
    let bound: { escrows: { output: BuiltDeposit; refund: BuiltDeposit }; deadline: bigint };
    return runSpend(
        ctx,
        {
            options: args,
            async plan(ctx) {
                // Bound here because `submitSwap` is optional on `Submitter` and type narrowing
                // does not carry into the submit closure.
                const { submitter } = ctx.cfg;
                const submitSwap = submitter.submitSwap?.bind(submitter);
                if (!submitSwap) {
                    throw new UnsupportedOperationError("swap", ["submitter.submitSwap"]);
                }
                const quote = checkQuote(args.quote);
                // Validated up front so a malformed recipient fails before selection.
                const recipient = shieldedRecipient(
                    ctx.J,
                    args.recipient ?? ctx.address,
                    "swap",
                ).address;

                const [asset, assetOut] = await resolveSwapAssets(
                    ctx,
                    quote.assetIn.id,
                    quote.assetOut.id,
                );
                const wrapper = await resolveSwapWrapper(ctx, "swap");
                const out = resolveOutAmount(
                    quote.side === "gross"
                        ? { gross: circuitAmount(quote.gross.amount) }
                        : { net: { baseUnits: quote.net.baseUnits } },
                    asset,
                    "swap",
                );
                const legs = await swapLegs(ctx, asset, assetOut, out, quote.minOut);
                assertQuoteReproduced(quote, { asset, assetOut, legs });
                // Resolved before selection or proving; a swap without a refund address would
                // otherwise fail only at `SwapWrapper.swap`.
                const refundTo = await resolveRefundAddress(ctx, args.refundAddress, wrapper);
                // The relayer's fee is paid in leg 1, the only leg that spends notes, and is quoted
                // as a swap because its gas covers both legs plus the venue.
                return {
                    feeKind: "swap" as const,
                    asset,
                    target: out.gross,
                    assetOut,
                    legs,
                    quote,
                    recipient,
                    wrapper,
                    refundTo,
                    submitSwap,
                };
            },
            bind(ctx, plan) {
                const { asset, assetOut, legs, quote, wrapper } = plan;
                // Leg 2 is built first because leg 1's proof binds a hash over it.
                const escrows = buildSwapEscrows(ctx, wrapper, {
                    output: {
                        asset: assetOut,
                        value: legs.credit,
                        fee: legs.outputFee,
                        recipientAddress: plan.recipient,
                    },
                    refund: {
                        asset,
                        value: legs.refundCredit,
                        fee: legs.refundFee,
                        recipientAddress: ctx.address,
                    },
                });
                // The default deadline is computed here, after selection and any
                // auto-consolidation, so they do not shorten the swap's window.
                const deadline = resolveSwapDeadline(args.deadline);
                bound = { escrows, deadline };
                // `refundTo` must be an account that can hold tokens, unlike the `Bundler` named
                // as `payer`.
                const swap: SwapBlob = {
                    adapter: quote.route.adapter,
                    route: quote.route.path,
                    depositD: escrows.output.deposit,
                    auxD: auxOutputFromWire(escrows.output.aux),
                    feeAuxD: auxOutputFromWire(escrows.output.feeAux),
                    refundD: escrows.refund.deposit,
                    refundAuxD: auxOutputFromWire(escrows.refund.aux),
                    refundFeeAuxD: auxOutputFromWire(escrows.refund.feeAux),
                    tokenIn: asset.token,
                    tokenOut: assetOut.token,
                    amountIn: legs.out.net,
                    minOut: quote.minOut,
                    deadline,
                    refundTo: plan.refundTo,
                };
                // `relayer` and `recipient` are the wrapper: it calls `MASP.withdraw`, so it is the
                // pool's `msg.sender` and the token destination. `payer` is the relayer's published
                // submitter (its `Bundler` when bundling), the only account allowed to call the
                // wrapper for this swap, so a proof taken from the mempool cannot be submitted by
                // anyone else; naming the wrapper reverts `UnauthorizedSwapCaller`. `intentHash`
                // binds the rest of the blob, which the wrapper recomputes (`IntentMismatch`).
                return {
                    kind: "withdraw",
                    payer: ctx.cfg.relayerAddress,
                    relayer: wrapper,
                    recipient: wrapper,
                    publicOut: legs.out.gross,
                    intentHash: swapIntentHash(swap),
                    deadline,
                    submit: ({ payload: { proof, pubInputs, aux } }) => {
                        const payload: SubmitSwapPayload = {
                            chainId: ctx.cfg.chainId,
                            proof,
                            pubInputs,
                            aux,
                            swap,
                        };
                        return plan.submitSwap(payload);
                    },
                };
            },
            // The output or refund note appears asynchronously via the relayer's `flushBatch`.
            result: (_ctx, { asset, assetOut, legs }, landed): SwapResult => ({
                kind: "swap",
                ...landedBase(landed, asset),
                fees: swapFees(asset, assetOut, legs, landed.relayerFee),
                assetOut,
                gross: shieldedMoney(asset, legs.out.gross),
                net: publicMoney(asset, legs.out.net),
                onLadder: isDenomination(legs.out.gross, asset.ladder),
                expectedCredit: shieldedMoney(assetOut, legs.credit),
                refundCredit: shieldedMoney(asset, legs.refundCredit),
                creditCommitment: fieldToBytes32(bound.escrows.output.cm),
                refundCommitment: fieldToBytes32(bound.escrows.refund.cm),
                deadline: bound.deadline,
                spent: landed.spent,
                change: landed.change,
            }),
        },
        run,
    );
}

function checkQuote(quote: unknown): CheckedQuote {
    const q = (quote ?? {}) as Partial<Record<keyof SwapQuote, unknown>>;
    const big = (v: unknown) => typeof v === "bigint";
    const field = (v: unknown, key: string) => (v as Record<string, unknown> | null)?.[key];
    const route = q.route as Partial<SwapQuote["route"]> | undefined;
    const ok =
        q.kind === "swapQuote" &&
        (q.side === "gross" || q.side === "net") &&
        big(field(q.assetIn, "id")) &&
        big(field(q.assetOut, "id")) &&
        big(field(q.gross, "amount")) &&
        big(field(q.net, "baseUnits")) &&
        big(field(q.credit, "amount")) &&
        big(field(q.refundCredit, "amount")) &&
        big(q.minOut) &&
        big(q.expectedOut) &&
        typeof route?.adapter === "string" &&
        ADDRESS.test(route.adapter) &&
        typeof route.path === "string" &&
        HEX_BLOB.test(route.path);
    if (!ok) {
        throw new InvalidArgumentError("swap: quote is not a SwapQuote from quoteSwap", {
            argument: "quote",
        });
    }
    const minOut = q.minOut as bigint;
    if (minOut <= 0n || minOut > (q.expectedOut as bigint)) {
        throw new InvalidArgumentError(
            "swap: quote.minOut must be positive and at most expectedOut",
            { argument: "quote" },
        );
    }
    return q as unknown as CheckedQuote;
}

/**
 * Refuse a quote whose figures the current pool state does not reproduce: `QUOTE_STALE` when the
 * quote is consistent with its own snapshot (an index or the flush fee moved; re-quote), and
 * `INVALID_ARGUMENT` when it is not (it was altered).
 */
function assertQuoteReproduced(
    quote: CheckedQuote,
    now: { asset: AssetInfo; assetOut: AssetInfo; legs: SwapLegs },
): void {
    const differing = (
        [
            ["gross", now.legs.out.gross, quote.gross.amount],
            ["net", now.legs.out.net, quote.net.baseUnits],
            ["credit", now.legs.credit, quote.credit.amount],
            ["refundCredit", now.legs.refundCredit, quote.refundCredit.amount],
        ] as const
    )
        .filter(([, recomputed, quoted]) => recomputed !== quoted)
        .map(([name]) => name);
    if (differing.length === 0) return;
    const altered = quoteInconsistency(quote, { assetIn: now.asset, assetOut: now.assetOut });
    if (altered !== undefined) {
        throw new InvalidArgumentError(
            `swap: quote.${altered} is not what quoteSwap produced; the quote was altered — ` +
                "request a new quote",
            { argument: "quote", details: { field: altered } },
        );
    }
    throw new QuoteStaleError({ fields: differing }, { details: { field: differing.join(",") } });
}
