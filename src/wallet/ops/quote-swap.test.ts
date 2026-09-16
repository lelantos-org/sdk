// `quoteSwap` → `swap`: the quote's figures are the ones execution encodes,
// including on a yield asset, and a quote execution would not reproduce is refused before proving.

import { describe, expect, it, vi } from "vitest";
import { assetId, circuitAmount, evmAddress } from "../../core/brand.js";
import { depositTotal, unitFee, withdrawNet } from "../../protocol/fees.js";
import type { SubmitSwapPayload } from "../../protocol/transact.js";
import { RAY } from "../../protocol/units.js";
import { makeTestCtx } from "../../test-utils/context.js";
import { estimateOf, freshAddress } from "../../test-utils/estimate.js";
import { storedNote } from "../../test-utils/wallet.js";
import type { AssetInfo } from "../assets/info.js";
import type { SwapQuote } from "../types/quotes.js";
import { quoteSwap } from "./quote-swap.js";
import { executeSwap } from "./swap.js";

const P = assetId(1n); // plain, scale 1, 30 bps withdraw
const Y = assetId(3n); // yield, scale 10, index 2·RAY, 30 bps withdraw
const OUT = assetId(2n); // plain, scale 1000, 20 bps deposit
const YOUT = assetId(4n); // yield output, scale 1000, 20 bps deposit, 1.5 tokens-per-scale
const WRAPPER = evmAddress(`0x${"cc".repeat(20)}`);
const REFUND = evmAddress(`0x${"ee".repeat(20)}`);

const ASSETS: Record<string, Partial<AssetInfo>> = {
    "1": {
        id: P,
        token: evmAddress(`0x${"a1".repeat(20)}`),
        scale: 1n,
        withdrawBps: 30n,
        depositBps: 0n,
    },
    "2": {
        id: OUT,
        token: evmAddress(`0x${"b2".repeat(20)}`),
        scale: 1_000n,
        withdrawBps: 0n,
        depositBps: 20n,
    },
    "3": {
        id: Y,
        token: evmAddress(`0x${"c3".repeat(20)}`),
        scale: 10n,
        withdrawBps: 30n,
        depositBps: 0n,
        index: 2n * RAY,
        yieldEnabled: true,
        // `gross / supply` tokens per unit: scale 10 at index 2.
        rate: { gross: 20n, supply: 1n },
    },
    "4": {
        id: YOUT,
        token: evmAddress(`0x${"d4".repeat(20)}`),
        scale: 1_000n,
        withdrawBps: 0n,
        depositBps: 20n,
        index: (3n * RAY) / 2n,
        yieldEnabled: true,
        rate: { gross: 3_000n, supply: 2n },
    },
};

async function swapCtx(assetIn: bigint) {
    const quoted: { amount_in: string; apiKey: string | null }[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { amount_in: string };
        quoted.push({ ...body, apiKey: new Headers(init?.headers).get("x-api-key") });
        return new Response(
            JSON.stringify({
                venue: "univ3",
                adapter: `0x${"ad".repeat(20)}`,
                route: `0x${"00".repeat(64)}`,
                expected_out: "5000000",
                min_out: "4975000",
                gas_estimate: 1,
                quoted_at: 1_800_000_000,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
        );
    }) as unknown as typeof globalThis.fetch;
    const made = await makeTestCtx({
        notes: [storedNote("01", 100_000n, { asset: assetIn })],
        estimate: estimateOf(await freshAddress(), { "1": 3n, "2": 2n, "3": 4n, "4": 2n }),
        resolveAsset: async (ref) => ({
            disabled: false,
            decimals: 6,
            ladder: [],
            ...ASSETS[String(ref)],
        }),
        cfg: {
            quoterUrl: "http://quoter.test",
            swapWrapperAddress: WRAPPER,
            // The wallet's transport options reach the quoter as they reach the relayer.
            http: { fetch, headers: { "x-api-key": "k" } },
        },
    });
    const submitSwap = vi.fn(async (_p: SubmitSwapPayload) => ({ txHash: `0x${"12".repeat(32)}` }));
    (made.ctx.cfg.submitter as { submitSwap?: unknown }).submitSwap = submitSwap;
    return { ...made, submitSwap, quoted };
}

describe("quoteSwap then swap", () => {
    it.each([
        ["a plain asset, net", P, { net: { baseUnits: 1_000n } }],
        ["a yield asset, net", Y, { net: { baseUnits: 1_000n } }],
        ["a yield asset, gross", Y, { gross: circuitAmount(50n) }],
    ] as const)("encodes exactly the quote's amounts for %s", async (_, assetIn, amount) => {
        const { ctx, submitSwap, witness, quoted } = await swapCtx(assetIn);
        const quote = await quoteSwap(ctx, { assetIn, assetOut: OUT, slippageBps: 50, ...amount });

        const info = ASSETS[String(assetIn)] as AssetInfo;
        // The venue's amountIn is what leg 1 delivers at the pool's index, not at scale alone.
        const delivered = withdrawNet({
            publicOut: quote.gross.amount,
            feeBps: info.withdrawBps,
            scale: info.scale,
            index: info.index,
            yieldEnabled: info.yieldEnabled,
        }).net;
        expect(quote.net.baseUnits).toBe(delivered);
        expect(BigInt(quoted[0]!.amount_in)).toBe(delivered);
        expect(quoted[0]!.apiKey).toBe("k");
        expect(quote.fees.protocol?.baseUnits).toBe(
            withdrawNet({ ...info, publicOut: quote.gross.amount, feeBps: info.withdrawBps }).fee,
        );
        expect(quote.fees.relayer?.asset).toBe(assetIn);
        expect(quote.fees.flush).toMatchObject({ asset: OUT, amount: 2n });
        expect(quote.side).toBe("net" in amount ? "net" : "gross");
        expect(Object.isFrozen(quote)).toBe(true);

        // A structured clone, as a UI cache would hold it.
        const res = await executeSwap(ctx, {
            quote: structuredClone(quote),
            refundAddress: REFUND,
        });
        const { swap } = submitSwap.mock.calls[0]![0];
        expect(swap.amountIn).toBe(quote.net.baseUnits);
        expect(swap.minOut).toBe(quote.minOut);
        expect(swap.depositD.publicIn).toBe(quote.credit.amount);
        expect(swap.refundD.publicIn).toBe(quote.refundCredit.amount);
        expect(swap.adapter).toBe(`0x${"ad".repeat(20)}`);
        expect(BigInt(witness.last!.public_out as string)).toBe(quote.gross.amount);

        expect(res).toMatchObject({
            kind: "swap",
            gross: quote.gross,
            net: quote.net,
            onLadder: quote.onLadder,
            expectedCredit: quote.credit,
            refundCredit: quote.refundCredit,
        });
        expect(res.creditCommitment).toMatch(/^0x[0-9a-f]{64}$/);
        expect(res.refundCommitment).not.toBe(res.creditCommitment);
        expect(res.fees.relayer).toEqual(quote.fees.relayer);
    });

    it.each([
        [
            "an inflated credit",
            (q: SwapQuote) => ({ ...q, credit: { ...q.credit, amount: q.credit.amount + 1n } }),
        ],
        [
            "a shrunk gross",
            (q: SwapQuote) => ({ ...q, gross: { ...q.gross, amount: q.gross.amount - 1n } }),
        ],
        [
            "a raised net",
            (q: SwapQuote) => ({ ...q, net: { ...q.net, baseUnits: q.net.baseUnits + 1n } }),
        ],
        ["minOut above expectedOut", (q: SwapQuote) => ({ ...q, minOut: q.expectedOut + 1n })],
        ["another route shape", (q: SwapQuote) => ({ ...q, route: "0xdeadbeef" })],
    ] as const)("refuses a quote with %s before proving", async (_, tamper) => {
        const { ctx, submitSwap, witness } = await swapCtx(P);
        const quote = await quoteSwap(ctx, {
            assetIn: P,
            assetOut: OUT,
            slippageBps: 50,
            net: { baseUnits: 1_000n },
        });
        await expect(
            executeSwap(ctx, { quote: tamper(quote) as SwapQuote, refundAddress: REFUND }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "quote" });
        expect(submitSwap).not.toHaveBeenCalled();
        expect(witness.last).toBeUndefined();
    });

    it.each([
        ["an index that moved (net side)", { net: { baseUnits: 1_000n } }, ["gross"]],
        ["an index that moved (gross side)", { gross: circuitAmount(50n) }, ["net"]],
    ] as const)("refuses a quote made stale by %s as QUOTE_STALE, retryable", async (_, amount, fields) => {
        const { ctx, submitSwap } = await swapCtx(Y);
        const quote = await quoteSwap(ctx, {
            assetIn: Y,
            assetOut: OUT,
            slippageBps: 50,
            ...amount,
        });
        // The pool's index grows between quoting and swapping.
        const resolve = ctx.assets.resolveVerified;
        (ctx.assets as { resolveVerified: unknown }).resolveVerified = async (ref: unknown) => {
            const a = await resolve(ref as never);
            return a.id === Y ? { ...a, index: 3n * RAY, rate: { gross: 30n, supply: 1n } } : a;
        };
        const err = await executeSwap(ctx, { quote, refundAddress: REFUND }).catch(
            (e: unknown) => e,
        );
        expect(err).toMatchObject({ code: "QUOTE_STALE", retryable: true });
        expect((err as { fields: string[] }).fields).toEqual(expect.arrayContaining([...fields]));
        expect(submitSwap).not.toHaveBeenCalled();
    });

    it("refuses a quote whose flush fee moved as QUOTE_STALE, naming the credit", async () => {
        const { ctx, submitSwap } = await swapCtx(P);
        const quote = await quoteSwap(ctx, {
            assetIn: P,
            assetOut: OUT,
            slippageBps: 50,
            gross: circuitAmount(10_000n),
        });
        const raised = estimateOf(await freshAddress(), { "1": 3n, "2": 9n, "3": 4n });
        (ctx.cfg.submitter as { estimate: unknown }).estimate = async () => raised;
        await expect(executeSwap(ctx, { quote, refundAddress: REFUND })).rejects.toMatchObject({
            code: "QUOTE_STALE",
            retryable: true,
            fields: ["credit"],
        });
        expect(submitSwap).not.toHaveBeenCalled();
    });

    it("keeps INVALID_ARGUMENT for a stale-looking quote whose snapshot was edited", async () => {
        const { ctx } = await swapCtx(Y);
        const quote = await quoteSwap(ctx, {
            assetIn: Y,
            assetOut: OUT,
            slippageBps: 50,
            gross: circuitAmount(50n),
        });
        // A forged index makes the figures self-consistent only with a snapshot the pool never had.
        const forged = { ...quote, net: { ...quote.net, baseUnits: quote.net.baseUnits + 5n } };
        await expect(
            executeSwap(ctx, { quote: forged as SwapQuote, refundAddress: REFUND }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { field: "net" } });
        // Once the figures differ, a snapshot no rate change explains is tampering too.
        const resolve = ctx.assets.resolveVerified;
        (ctx.assets as { resolveVerified: unknown }).resolveVerified = async (ref: unknown) => {
            const a = await resolve(ref as never);
            return a.id === Y ? { ...a, index: 3n * RAY, rate: { gross: 30n, supply: 1n } } : a;
        };
        const rescaled = { ...quote, assetIn: { ...quote.assetIn, scale: 1n } };
        await expect(
            executeSwap(ctx, { quote: rescaled as SwapQuote, refundAddress: REFUND }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { field: "assetIn.scale" } });
    });

    it("sizes a yield output note through the pool's rate, and its protocol fee in units", async () => {
        const { ctx, submitSwap } = await swapCtx(P);
        const quote = await quoteSwap(ctx, {
            assetIn: P,
            assetOut: YOUT,
            slippageBps: 50,
            gross: circuitAmount(10_000n),
        });
        const out = ASSETS[String(YOUT)] as AssetInfo;
        const pull = (v: bigint) =>
            depositTotal({
                publicIn: v,
                feeIn: 2n,
                depositBps: out.depositBps,
                scale: out.scale,
                yieldEnabled: true,
                rate: out.rate,
            });
        // The wrapper's window: the pull covers minOut, by the smallest note that does.
        expect(pull(quote.credit.amount)).toBeGreaterThanOrEqual(quote.minOut);
        expect(pull(quote.credit.amount - 1n)).toBeLessThan(quote.minOut);
        expect(quote.fees.outProtocol).toEqual({
            asset: YOUT,
            amount: unitFee(quote.credit.amount, out.depositBps),
            baseUnits: expect.any(BigInt),
        });

        await executeSwap(ctx, { quote: structuredClone(quote), refundAddress: REFUND });
        expect(submitSwap.mock.calls[0]![0].swap.depositD.publicIn).toBe(quote.credit.amount);
    });

    it("refuses without a wrapper address, and one asset named twice", async () => {
        const { ctx } = await swapCtx(P);
        (ctx.cfg as { swapWrapperAddress?: string | undefined }).swapWrapperAddress = undefined;
        await expect(
            quoteSwap(ctx, {
                assetIn: P,
                assetOut: OUT,
                slippageBps: 50,
                gross: circuitAmount(10n),
            }),
        ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
        await expect(
            quoteSwap(ctx, {
                assetIn: P,
                assetOut: 1n,
                slippageBps: 50,
                gross: circuitAmount(10n),
            }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "assetOut" });
    });

    it("reads the wrapper from the relayer when the preset names none", async () => {
        const { ctx } = await swapCtx(P);
        (ctx.cfg as { swapWrapperAddress?: string | undefined }).swapWrapperAddress = undefined;
        (ctx.relayerInfo as { swapWrapperAddress: unknown }).swapWrapperAddress = async () =>
            WRAPPER;
        const quote = await quoteSwap(ctx, {
            assetIn: P,
            assetOut: OUT,
            slippageBps: 50,
            gross: circuitAmount(100n),
        });
        expect(quote.gross.amount).toBe(100n);
    });

    it("refuses bad slippage and a non-positive amount before any I/O", async () => {
        const { ctx, quoted } = await swapCtx(P);
        await expect(
            quoteSwap(ctx, {
                assetIn: P,
                assetOut: OUT,
                slippageBps: 10_001,
                gross: circuitAmount(1n),
            }),
        ).rejects.toMatchObject({ argument: "slippageBps" });
        await expect(
            quoteSwap(ctx, { assetIn: P, assetOut: OUT, slippageBps: 50, net: "0" }),
        ).rejects.toMatchObject({ argument: "net" });
        expect(quoted).toHaveLength(0);
    });
});
