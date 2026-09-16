// Pricing a swap. Backs `wallet.quoteSwap`; `wallet.swap` recomputes every figure here with the
// same functions (`tx/swap-terms.ts`) and refuses a quote they do not reproduce.

import { branded, type EvmAddress, type TokenAmount } from "../../core/brand.js";
import { UnsupportedOperationError } from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { WireFormatError } from "../../errors/network.js";
import { isDenomination } from "../../protocol/denominations.js";
import { fetchSwapQuote } from "../../services/quoter/client.js";
import {
    precheckAmount,
    publicMoney,
    requireOutSide,
    resolveOutAmount,
    shieldedMoney,
} from "../assets/amount.js";
import type { WalletContext } from "../context.js";
import { serviceHttpOptions } from "../defaults/http.js";
import { relayerMoney, resolveSpendFee } from "../tx/fee.js";
import { resolveSwapAssets, resolveSwapWrapper, swapFees, swapLegs } from "../tx/swap-terms.js";
import type { QuoteSwapOptions } from "../types/options.js";
import type { SwapQuote } from "../types/quotes.js";

export async function quoteSwap(ctx: WalletContext, args: QuoteSwapOptions): Promise<SwapQuote> {
    const { signal } = args;
    const slippageBps = args.slippageBps;
    if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
        throw new InvalidArgumentError("quoteSwap: slippageBps must be an integer in 0..10000", {
            argument: "slippageBps",
        });
    }
    const side = requireOutSide(args, "quoteSwap");
    precheckAmount(args[side], side, "quoteSwap");
    const quoterUrl = ctx.cfg.quoterUrl;
    if (!quoterUrl) throw new UnsupportedOperationError("quoteSwap", ["quoterUrl"]);
    signal?.throwIfAborted();

    const [assetIn, assetOut] = await resolveSwapAssets(ctx, args.assetIn, args.assetOut);
    await resolveSwapWrapper(ctx, "quoteSwap");
    const out = resolveOutAmount(args, assetIn, "quoteSwap");
    const { feeAsset, fee } = await resolveSpendFee(ctx, "swap", assetIn, args.feeAsset);
    signal?.throwIfAborted();

    const venue = await fetchSwapQuote(
        quoterUrl,
        {
            chainId: ctx.cfg.chainId,
            tokenIn: assetIn.token,
            tokenOut: assetOut.token,
            amountIn: out.net,
            slippageBps,
        },
        { ...serviceHttpOptions(ctx.cfg.http, "quoter"), ...(signal ? { signal } : {}) },
    );
    if (venue.minOut > venue.expectedOut) {
        throw new WireFormatError("$.min_out", "the quoter's min_out exceeds its expected_out");
    }
    signal?.throwIfAborted();
    const legs = await swapLegs(ctx, assetIn, assetOut, out, venue.minOut);

    return Object.freeze({
        kind: "swapQuote" as const,
        assetIn,
        assetOut,
        side: out.side,
        gross: shieldedMoney(assetIn, out.gross),
        net: publicMoney(assetIn, out.net),
        onLadder: isDenomination(out.gross, assetIn.ladder),
        slippageBps,
        expectedOut: branded<TokenAmount>(venue.expectedOut),
        minOut: branded<TokenAmount>(venue.minOut),
        credit: shieldedMoney(assetOut, legs.credit),
        refundCredit: shieldedMoney(assetIn, legs.refundCredit),
        fees: swapFees(assetIn, assetOut, legs, relayerMoney(feeAsset, fee)),
        venue: venue.venue,
        quotedAt: venue.quotedAt,
        // `fetchSwapQuote` validated the adapter as a 20-byte address.
        route: Object.freeze({ adapter: branded<EvmAddress>(venue.adapter), path: venue.route }),
    });
}
