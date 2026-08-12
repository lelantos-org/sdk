import { describe, expect, it } from "vitest";
import type { ChainAdapter } from "../chain/port.js";
import { assetId, circuitAmount, evmAddress } from "../core/brand.js";
import {
    type AssetInfo,
    type AssetInfoWithMeta,
    fetchAssetInfo,
    formatAmount,
    hasTokenMeta,
    minAmount,
    parseAmount,
    requireTokenMeta,
} from "./assets.js";

const WETH: AssetInfoWithMeta = {
    id: assetId(1n),
    token: evmAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
    scale: 10n ** 15n,
    disabled: false,
    symbol: "WETH",
    decimals: 18,
};

function stubChain(over: Record<string, unknown> = {}): ChainAdapter {
    return {
        fetchAsset: async () => ({ token: WETH.token, scale: WETH.scale, disabled: false }),
        tokenMeta: async () => ({ symbol: "WETH", decimals: 18 }),
        ...over,
    } as unknown as ChainAdapter;
}

/** `AssetInfo` as an adapter without `tokenMeta` would resolve it. */
const NO_META: AssetInfo = { ...WETH, symbol: undefined, decimals: undefined };

describe("fetchAssetInfo", () => {
    it("merges the registry entry with ERC-20 metadata", async () => {
        expect(await fetchAssetInfo(stubChain(), assetId(1n))).toEqual(WETH);
    });

    it("omits metadata when the adapter has no `tokenMeta`", async () => {
        const info = await fetchAssetInfo(stubChain({ tokenMeta: undefined }), assetId(1n));
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
        const info = await fetchAssetInfo(chain, assetId(1n));
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
        expect(formatAmount(circuitAmount(250n), WETH, { symbol: true })).toBe("0.25 WETH");
        expect(
            formatAmount(circuitAmount(250n), { ...WETH, symbol: undefined }, { symbol: true }),
        ).toBe("0.25");
    });

    it("reports the smallest representable amount", () => {
        expect(minAmount(WETH)).toBe("0.001");
    });

    it("rejects an amount finer than one circuit unit", () => {
        expect(() => parseAmount("0.0001", WETH)).toThrow(/not a multiple of scale/);
    });
});

describe("token-metadata narrowing", () => {
    // Human-unit conversion is defined only against `AssetInfoWithMeta`, so an
    // asset with no `decimals` is rejected by the compiler. These guards are
    // how a caller crosses from one to the other at runtime.
    it("narrows an asset that carries decimals", () => {
        const asset: AssetInfo = WETH;
        expect(hasTokenMeta(asset)).toBe(true);
        if (hasTokenMeta(asset)) expect(parseAmount("1", asset)).toBe(1000n);
    });

    it("rejects one that does not", () => {
        expect(hasTokenMeta(NO_META)).toBe(false);
        expect(() => requireTokenMeta(NO_META)).toThrow(/does not implement `tokenMeta`/);
    });

    it("passes a resolved asset straight through", () => {
        expect(requireTokenMeta(WETH)).toBe(WETH);
    });
});
