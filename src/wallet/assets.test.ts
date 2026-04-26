import { describe, expect, it } from "vitest";
import type { ChainAdapter } from "../chain/port.js";
import { type AssetInfo, fetchAssetInfo, formatAmount, minAmount, parseAmount } from "./assets.js";

const WETH: AssetInfo = {
    id: 1n,
    token: "0xC02a",
    scale: 10n ** 15n,
    disabled: false,
    symbol: "WETH",
    decimals: 18,
};

function stubChain(over: Partial<ChainAdapter> = {}): ChainAdapter {
    return {
        fetchAsset: async () => ({ token: WETH.token, scale: WETH.scale, disabled: false }),
        tokenMeta: async () => ({ symbol: "WETH", decimals: 18 }),
        ...over,
    } as unknown as ChainAdapter;
}

describe("fetchAssetInfo", () => {
    it("merges the registry entry with ERC-20 metadata", async () => {
        expect(await fetchAssetInfo(stubChain(), 1n)).toEqual(WETH);
    });

    it("omits metadata when the adapter has no `tokenMeta`", async () => {
        const info = await fetchAssetInfo(stubChain({ tokenMeta: undefined }), 1n);
        expect(info.symbol).toBeUndefined();
        expect(info.decimals).toBeUndefined();
        expect(info.scale).toBe(WETH.scale);
    });

    it("survives a non-standard ERC-20 that reverts on symbol()", async () => {
        const chain = stubChain({
            tokenMeta: async () => {
                throw new Error("execution reverted");
            },
        });
        const info = await fetchAssetInfo(chain, 1n);
        expect(info.decimals).toBeUndefined();
        expect(info.token).toBe(WETH.token);
    });
});

describe("parseAmount / formatAmount", () => {
    it("converts a human string to circuit units", () => {
        // 0.25 WETH = 2.5e17 base units; scale 1e15 → 250 circuit units.
        expect(parseAmount("0.25", WETH)).toBe(250n);
        expect(parseAmount(1, WETH)).toBe(1000n);
    });

    it("round-trips", () => {
        expect(formatAmount(parseAmount("0.25", WETH), WETH)).toBe("0.25");
    });

    it("appends the symbol on request", () => {
        expect(formatAmount(250n, WETH, { symbol: true })).toBe("0.25 WETH");
        expect(formatAmount(250n, { ...WETH, symbol: undefined }, { symbol: true })).toBe("0.25");
    });

    it("reports the smallest representable amount", () => {
        expect(minAmount(WETH)).toBe("0.001");
    });

    it("rejects an amount finer than one circuit unit", () => {
        expect(() => parseAmount("0.0001", WETH)).toThrow(/not a multiple of scale/);
    });

    it("explains itself when decimals are unknown", () => {
        const unknown = { ...WETH, decimals: undefined };
        expect(() => parseAmount("1", unknown)).toThrow(/does not implement `tokenMeta`/);
        expect(() => formatAmount(1n, unknown)).toThrow(/no known decimals/);
    });
});
