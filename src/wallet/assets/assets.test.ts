import { describe, expect, it } from "vitest";
import type { ChainAdapter } from "../../chain/port.js";
import { assetId, evmAddress } from "../../core/brand.js";
import { RAY } from "../../protocol/units.js";
import { parseAmount } from "./amount.js";
import {
    type AssetInfo,
    type AssetInfoWithMeta,
    fetchAssetInfo,
    hasTokenMeta,
    makeAssetInfo,
    minAmount,
    requireTokenMeta,
} from "./index.js";

// Built through `makeAssetInfo` so the ladder is derived from `scale` and
// `decimals`. `index` and `yieldEnabled` default to a plain asset's.
const WETH: AssetInfoWithMeta = requireTokenMeta(
    makeAssetInfo({
        id: assetId(1n),
        token: evmAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
        scale: 10n ** 15n,
        symbol: "WETH",
        decimals: 18,
    }),
);

function stubChain(over: Record<string, unknown> = {}): ChainAdapter {
    return {
        fetchAsset: async () => ({
            token: WETH.token,
            scale: WETH.scale,
            disabled: false,
            depositBps: 0n,
            withdrawBps: 0n,
            index: RAY,
            yieldEnabled: false,
        }),
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

describe("minAmount", () => {
    it("reports the smallest representable amount", () => {
        expect(minAmount(WETH)).toBe("0.001");
    });
});

describe("token-metadata narrowing", () => {
    // Human-unit conversion is defined only against `AssetInfoWithMeta`; these
    // guards narrow to it at runtime.
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
