import { describe, expect, it } from "vitest";
import type { AssetId, CircuitAmount } from "../core/brand.js";
import { branded } from "../core/brand.js";
import type { EstimateResponse } from "../protocol/responses.js";
import type { AssetInfo } from "./assets.js";
import { quoteFee } from "./fee-quote.js";

const WETH = {
    id: 1n,
    token: "0xa",
    scale: 1n,
    disabled: false,
    symbol: "WETH",
} as unknown as AssetInfo;
const USDC = {
    id: 2n,
    token: "0xb",
    scale: 1n,
    disabled: false,
    symbol: "USDC",
} as unknown as AssetInfo;

function ctx(opts: { estimate?: EstimateResponse | undefined; balances?: Record<string, bigint> }) {
    return {
        cfg: { chainId: 31337n },
        submitter: opts.estimate ? { estimate: async () => opts.estimate! } : {},
        async resolveAsset(ref: unknown) {
            const id = BigInt(ref as bigint);
            const hit = [WETH, USDC].find((a) => a.id === id);
            if (!hit) throw new Error(`unregistered ${id}`);
            return hit;
        },
        balances: () =>
            new Map<AssetId, CircuitAmount>(
                Object.entries(opts.balances ?? {}).map(([k, v]) => [
                    branded<AssetId>(BigInt(k)),
                    branded<CircuitAmount>(v),
                ]),
            ),
    } as unknown as Parameters<typeof quoteFee>[0];
}

const estimate = (fees: EstimateResponse["fees"], addr = "lelantos1relayer"): EstimateResponse => ({
    gasUsed: 1,
    effectiveGasPriceWei: "1",
    totalNativeWei: "1",
    markupBps: 0,
    quotedAt: 0,
    shieldedFeeAddress: addr,
    fees,
});

const fee = (assetId: number, circuitAmount: string) => ({
    tokenSymbol: `T${assetId}`,
    tokenAddress: "0x",
    decimals: 18,
    amount: circuitAmount,
    assetId,
    circuitAmount,
});

describe("quoteFee", () => {
    it("reports what each accepted asset costs and whether it is affordable", async () => {
        const c = ctx({
            estimate: estimate([fee(1, "10"), fee(2, "25")]),
            balances: { "1": 100n, "2": 5n },
        });

        const { charged, payTo, options } = await quoteFee(c, { kind: "transfer" });

        expect(charged).toBe(true);
        expect(payTo).toBe("lelantos1relayer");
        expect(options.map((o) => [o.asset.symbol, o.amount, o.balance, o.affordable])).toEqual([
            ["WETH", 10n, 100n, true],
            // Quoted, held, but not enough of it.
            ["USDC", 25n, 5n, false],
        ]);
    });

    it("treats an asset with no balance as unaffordable, not absent", async () => {
        const c = ctx({ estimate: estimate([fee(2, "1")]) });
        const [only] = (await quoteFee(c, { kind: "transfer" })).options;
        expect([only?.balance, only?.affordable]).toEqual([0n, false]);
    });

    /// A relayer that subsidises gas charges nothing, and `feeAsset` is moot.
    it("reports no charge when the relayer publishes no fee address", async () => {
        const est = { ...estimate([fee(1, "10")]) };
        delete (est as { shieldedFeeAddress?: string }).shieldedFeeAddress;
        expect(await quoteFee(ctx({ estimate: est }), { kind: "transfer" })).toEqual({
            options: [],
            charged: false,
        });
    });

    it("reports no charge when the submitter cannot quote at all", async () => {
        expect(await quoteFee(ctx({}), { kind: "transfer" })).toEqual({
            options: [],
            charged: false,
        });
    });

    /// Quoted but unregistered here: no registry entry means no note can be
    /// built for it, so offering it would be offering something unpayable.
    it("drops an asset it cannot resolve", async () => {
        const c = ctx({ estimate: estimate([fee(1, "10"), fee(99, "10")]) });
        const { options } = await quoteFee(c, { kind: "transfer" });
        expect(options.map((o) => o.asset.id)).toEqual([1n]);
    });
});
