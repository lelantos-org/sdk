import { describe, expect, it, vi } from "vitest";
import { assetId, circuitAmount, evmAddress } from "../../core/brand.js";
import { randomJubjubScalar } from "../../core/random.js";
import { Jubjub } from "../../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../../crypto/poseidon.js";
import { addressFromSpendingKey, buildSpendingKey } from "../../keys/keys.js";
import type { AssetInfo } from "../assets/index.js";
import type { WalletContext } from "../context.js";
import type { SwapQuote } from "../types/quotes.js";
import { executeDeposit } from "./deposit.js";
import { quoteSwap } from "./quote-swap.js";
import { executeSwap } from "./swap.js";
import { executeWithdraw } from "./withdraw.js";

// Arguments no chain state can make valid are rejected before the operation reads the chain,
// quotes a fee or selects notes.

const WETH = { id: assetId(1n), symbol: "WETH", scale: 1n, ladder: [] } as unknown as AssetInfo;
const USDC = { id: assetId(2n), symbol: "USDC", scale: 1n, ladder: [] } as unknown as AssetInfo;

/** A context whose every side effect is a spy, resolving assets by id or symbol. */
async function spyCtx() {
    const J = await Jubjub.build();
    const P = await Poseidon.build();
    const address = addressFromSpendingKey(J, buildSpendingKey(P, J, randomJubjubScalar()));
    const touched = {
        payerAddress: vi.fn(async () => evmAddress(`0x${"aa".repeat(20)}`)),
        fetchAsset: vi.fn(async () => ({})),
        estimate: vi.fn(async () => ({})),
        storedNotes: vi.fn(() => []),
    };
    const ctx = {
        J,
        address,
        cfg: {
            chainId: 31337n,
            quoterUrl: "http://quoter.invalid",
            chain: { payerAddress: touched.payerAddress, fetchAsset: touched.fetchAsset },
            shape: { nIn: 4, nOut: 6 },
            submitter: { submit: vi.fn(), submitSwap: vi.fn(), estimate: touched.estimate },
        },
        notes: {
            get notes() {
                return touched.storedNotes();
            },
        },
        assets: {
            resolveVerified: async (ref: unknown) => {
                const hit = [WETH, USDC].find((a) => a.id === ref || a.symbol === ref);
                if (!hit) throw new Error(`fixture: no asset ${String(ref)}`);
                return hit;
            },
        },
    };
    const untouched = () => {
        for (const spy of Object.values(touched)) expect(spy).not.toHaveBeenCalled();
    };
    return { ctx, untouched };
}

describe("amount must be positive", () => {
    it("deposit rejects zero before reading the chain", async () => {
        const { ctx, untouched } = await spyCtx();
        await expect(
            executeDeposit(ctx as unknown as WalletContext, {
                asset: "WETH",
                amount: circuitAmount(0n),
            }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "amount" });
        untouched();
    });

    it.each([
        "withdraw",
        "withdrawNative",
    ] as const)("%s rejects zero before quoting or selecting", async (kind) => {
        const { ctx, untouched } = await spyCtx();
        await expect(
            executeWithdraw(ctx as unknown as WalletContext, {
                recipient: evmAddress(`0x${"bb".repeat(20)}`),
                gross: circuitAmount(0n),
                asset: "WETH",
                native: kind === "withdrawNative",
            }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "gross" });
        untouched();
    });

    it("quoteSwap rejects zero before quoting", async () => {
        const { ctx, untouched } = await spyCtx();
        await expect(
            quoteSwap(ctx as unknown as WalletContext, {
                assetIn: "WETH",
                assetOut: "USDC",
                net: "0",
                slippageBps: 50,
            }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "net" });
        untouched();
    });

    it.each([
        ["withdraw", { gross: circuitAmount(1n), net: circuitAmount(1n) }],
        ["quoteSwap", {}],
    ] as const)("%s refuses both or neither of gross and net, naming `gross`", async (op, out) => {
        const { ctx, untouched } = await spyCtx();
        const call =
            op === "withdraw"
                ? executeWithdraw(
                      ctx as unknown as WalletContext,
                      {
                          recipient: evmAddress(`0x${"bb".repeat(20)}`),
                          asset: "WETH",
                          ...out,
                      } as never,
                  )
                : quoteSwap(
                      ctx as unknown as WalletContext,
                      {
                          assetIn: "WETH",
                          assetOut: "USDC",
                          slippageBps: 50,
                          ...out,
                      } as never,
                  );
        await expect(call).rejects.toMatchObject({
            code: "INVALID_ARGUMENT",
            argument: "gross",
            message: `${op}: pass exactly one of \`gross\` or \`net\``,
        });
        untouched();
    });
});

describe("swap asset identity", () => {
    it("rejects one asset named two ways", async () => {
        const { ctx, untouched } = await spyCtx();
        // Compared as refs, `"WETH"` and `1n` differ, and the swap would proceed to proving.
        await expect(
            quoteSwap(ctx as unknown as WalletContext, {
                assetIn: "WETH",
                assetOut: assetId(1n),
                gross: circuitAmount(10n),
                slippageBps: 50,
            }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "assetOut" });
        untouched();
    });

    it("swap refuses a quote that is not one before resolving anything", async () => {
        const { ctx, untouched } = await spyCtx();
        await expect(
            executeSwap(ctx as unknown as WalletContext, { quote: {} as SwapQuote }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "quote" });
        untouched();
    });
});
