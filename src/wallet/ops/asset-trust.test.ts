import { describe, expect, it, vi } from "vitest";
import type { AssetEntry, Permit2SignArgs } from "../../chain/types.js";
import {
    type AssetId,
    assetId,
    branded,
    circuitAmount,
    evmAddress,
    type Hex32,
} from "../../core/brand.js";
import { WireFormatError } from "../../errors/network.js";
import type { DepositRequest } from "../../protocol/deposit-request.js";
import type { ChainToken } from "../../protocol/responses.js";
import type { SubmitSwapPayload } from "../../protocol/transact.js";
import { RAY } from "../../protocol/units.js";
import { makeTestCtx } from "../../test-utils/context.js";
import { minedDeposit } from "../../test-utils/deposit.js";
import { storedNote } from "../../test-utils/wallet.js";
import { withdrawNetFor } from "../assets/amounts.js";
import { lazyAssets } from "../assets/facade.js";
import { AssetRegistry } from "../assets/registry.js";
import type { WalletContext } from "../context.js";
import { executeDeposit } from "./deposit.js";
import { quoteSwap } from "./quote-swap.js";
import { executeSwap } from "./swap.js";
import { executeWithdraw } from "./withdraw.js";

// The relayer's `/chains` list names assets; it does not get to say what they are. Every operation
// that signs, pulls or sizes an amount reads token, scale, fees and yield state from the pool, and
// refuses a list that contradicts it before anything is signed or proven.

const A = assetId(1n);
const B = assetId(2n);
const Y = assetId(3n);
const TOKEN_A = evmAddress("0x000000000000000000000000000000000000a0a0");
const TOKEN_B = evmAddress("0x000000000000000000000000000000000000b0b0");
const TOKEN_Y = evmAddress("0x000000000000000000000000000000000000c0c0");
const ATTACKER = evmAddress("0x000000000000000000000000000000000000dead");
const PAYER = evmAddress("0x00000000000000000000000000000000000000aa");
const TX = branded<Hex32>(`0x${"11".repeat(32)}`);

/** The pool's registry. `Y` yields at twice its scale. */
const ENTRIES: Record<string, AssetEntry> = {
    "1": {
        token: TOKEN_A,
        scale: 10n,
        disabled: false,
        depositBps: 20n,
        withdrawBps: 30n,
        index: RAY,
        yieldEnabled: false,
    },
    "2": {
        token: TOKEN_B,
        scale: 1_000n,
        disabled: false,
        depositBps: 0n,
        withdrawBps: 0n,
        index: RAY,
        yieldEnabled: false,
    },
    "3": {
        token: TOKEN_Y,
        scale: 10n,
        disabled: false,
        depositBps: 0n,
        withdrawBps: 0n,
        index: 2n * RAY,
        yieldEnabled: true,
        rate: { gross: 2n, supply: 1n },
    },
};

function listed(over: Partial<Record<string, Partial<ChainToken>>> = {}): ChainToken[] {
    const base: ChainToken[] = [
        { assetId: 1, token: TOKEN_A, scale: "10", symbol: "AAA", decimals: 6 },
        { assetId: 2, token: TOKEN_B, scale: "1000", symbol: "BBB", decimals: 18 },
        {
            assetId: 3,
            token: TOKEN_Y,
            scale: "10",
            symbol: "YYY",
            decimals: 6,
            // Stale: the relayer still reports the index the pool started at.
            yieldState: {
                venue: "0x000000000000000000000000000000000000ee00",
                gross: "1",
                supply: "1",
                index: RAY.toString(),
                halted: false,
            },
        },
    ];
    // Relayer-advertised fee rates that differ from the pool's.
    return base.map((t) => ({
        depositBps: 0,
        withdrawBps: 0,
        ...t,
        ...over[String(t.assetId)],
    }));
}

const WRONG_TOKEN = listed({ "1": { token: ATTACKER } });
const WRONG_SCALE = listed({ "1": { scale: "1" } });

/** A signing chain layer that records every signature and submission. */
function signingChain() {
    return {
        fetchAsset: vi.fn(async (id: AssetId) => ENTRIES[id.toString()]!),
        payerAddress: vi.fn(async () => PAYER),
        maspAddress: async () => evmAddress("0x0000000000000000000000000000000000000a11"),
        nativeAdapterAddress: () => evmAddress("0x00000000000000000000000000000000000ada9e"),
        permit2Nonce: async () => 1n,
        signPermit2: vi.fn(async (args: Permit2SignArgs) => ({
            nonce: args.nonce,
            deadline: args.deadline,
            maxTotal: args.maxTotal,
            maxFee: args.maxFee ?? 0n,
            signature: "0x",
        })),
        submitDeposit: vi.fn(async (a: { deposit: DepositRequest }) => minedDeposit(a.deposit)),
    };
}

/** An operation context whose assets resolve through a real registry over `tokens`. */
async function ctxOver(tokens: ChainToken[], notes = [storedNote("01", 1_000n, { asset: A })]) {
    const chain = signingChain();
    const made = await makeTestCtx({ notes, chain });
    const ctx = {
        ...made.ctx,
        assets: lazyAssets(
            () => chain as never,
            { denominations: false },
            async () => tokens,
        ),
    } as WalletContext;
    return { ...made, ctx, chain };
}

function expectNothingSigned(chain: ReturnType<typeof signingChain>) {
    expect(chain.signPermit2).not.toHaveBeenCalled();
    expect(chain.submitDeposit).not.toHaveBeenCalled();
    expect(chain.payerAddress).not.toHaveBeenCalled();
}

describe("deposit trusts the pool, not the relayer's asset list", () => {
    it.each([
        ["token address", WRONG_TOKEN],
        ["scale", WRONG_SCALE],
    ])("refuses a listed %s that contradicts the chain, before signing", async (_, tokens) => {
        const { ctx, chain } = await ctxOver(tokens);
        const err = await executeDeposit(ctx, {
            asset: "AAA",
            amount: circuitAmount(100n),
        }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WireFormatError);
        expect(err).toMatchObject({ code: "WIRE_FORMAT", retryable: false });
        expectNothingSigned(chain);
    });

    it("refuses a fee asset whose listing contradicts the chain", async () => {
        const { ctx, chain } = await ctxOver(WRONG_TOKEN);
        await expect(
            executeDeposit(ctx, {
                asset: B,
                feeAsset: A,
                amount: circuitAmount(100n),
            }),
        ).rejects.toBeInstanceOf(WireFormatError);
        expectNothingSigned(chain);
    });

    it("signs for the chain's token, scale and deposit rate", async () => {
        const { ctx, chain } = await ctxOver(listed());
        await executeDeposit(ctx, { asset: "AAA", amount: circuitAmount(100n) });

        expect(chain.fetchAsset).toHaveBeenCalledWith(A);
        // 100 units at the pool's scale 10, plus its 0.2% deposit rate (the list says 0).
        expect(chain.signPermit2.mock.calls[0]![0]).toMatchObject({
            token: TOKEN_A,
            maxTotal: 1_002n,
        });
    });
});

describe("swap trusts the pool, not the relayer's asset list", () => {
    /** A quote as `quoteSwap` would make it over the pool's figures, never the list's. */
    async function quoteOver(ctx: WalletContext) {
        const fetch = (async () =>
            new Response(
                JSON.stringify({
                    venue: "univ3",
                    adapter: `0x${"ad".repeat(20)}`,
                    route: `0x${"00".repeat(64)}`,
                    expected_out: "5000",
                    min_out: "5000",
                    gas_estimate: 1,
                    quoted_at: 1,
                }),
                { status: 200, headers: { "content-type": "application/json" } },
            )) as unknown as typeof globalThis.fetch;
        Object.assign(ctx.cfg, {
            quoterUrl: "http://quoter.test",
            swapWrapperAddress: `0x${"cc".repeat(20)}`,
            http: { fetch },
        });
        return quoteSwap(ctx, {
            assetIn: "AAA",
            assetOut: "BBB",
            gross: circuitAmount(10n),
            slippageBps: 0,
        });
    }

    async function swapCtx(tokens: ChainToken[]) {
        const made = await ctxOver(tokens);
        const submitSwap = vi.fn(async (_p: SubmitSwapPayload) => ({ txHash: TX }));
        (made.ctx.cfg.submitter as { submitSwap?: unknown }).submitSwap = submitSwap;
        return { ...made, submitSwap };
    }

    it.each([
        ["token address", WRONG_TOKEN],
        ["scale", WRONG_SCALE],
    ])("refuses a listed %s that contradicts the chain, before quoting", async (_, tokens) => {
        const { ctx, submitSwap, witness } = await swapCtx(tokens);
        await expect(quoteOver(ctx)).rejects.toBeInstanceOf(WireFormatError);
        expect(witness.last).toBeUndefined();
        expect(submitSwap).not.toHaveBeenCalled();
    });

    it("binds the chain's tokens and sizes the legs from the chain's scale", async () => {
        const { ctx, chain, submitSwap } = await swapCtx(listed());
        const quote = await quoteOver(ctx);
        await executeSwap(ctx, { quote, refundAddress: evmAddress(`0x${"ee".repeat(20)}`) });

        expect(chain.fetchAsset).toHaveBeenCalledWith(A);
        expect(chain.fetchAsset).toHaveBeenCalledWith(B);
        const { swap } = submitSwap.mock.calls[0]![0];
        expect(swap.tokenIn).toBe(TOKEN_A);
        expect(swap.tokenOut).toBe(TOKEN_B);
        // Leg 1 publishes 10 units at the pool's scale 10; its 0.3% withdraw rate skims
        // floor(0.3) = 0 of the 100 tokens.
        expect(swap.amountIn).toBe(100n);
    });
});

describe("withdraw trusts the pool, not the relayer's asset list", () => {
    it("refuses a listed scale that contradicts the chain, before proving", async () => {
        const { ctx, witness, submitted } = await ctxOver(WRONG_SCALE);
        await expect(
            executeWithdraw(ctx, { recipient: PAYER, gross: circuitAmount(50n), asset: "AAA" }),
        ).rejects.toBeInstanceOf(WireFormatError);
        expect(witness.last).toBeUndefined();
        expect(submitted).toHaveLength(0);
    });

    it("settles at the chain's yield index, not the relayer's", async () => {
        const { ctx, chain } = await ctxOver(listed(), [storedNote("01", 1_000n, { asset: Y })]);
        const res = await executeWithdraw(ctx, {
            recipient: PAYER,
            gross: circuitAmount(50n),
            asset: Y,
        });

        expect(chain.fetchAsset).toHaveBeenCalledWith(Y);
        const onChain = await new AssetRegistry({
            chain: chain as never,
            denominations: false,
        }).resolveVerified(Y);
        expect(onChain.index).toBe(2n * RAY);
        expect(res.net.baseUnits).toBe(withdrawNetFor(50n, onChain).net);
        // The relayer's stale index would have reported half.
        expect(res.net.baseUnits).toBe(1_000n);
    });
});
