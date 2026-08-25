import { describe, expect, it, vi } from "vitest";
import type { ChainAdapter } from "../chain/port.js";
import type { ChainToken } from "../protocol/responses.js";
import { AssetRegistry } from "./asset-registry.js";

const TOKENS: ChainToken[] = [
    {
        assetId: 1,
        token: "0xAAaa000000000000000000000000000000000000",
        scale: "1000000000000",
        symbol: "WETH",
        decimals: 18,
    },
    {
        assetId: 2,
        token: "0xBBbb000000000000000000000000000000000000",
        scale: "1",
        symbol: "USDC",
        decimals: 6,
    },
];

function chain(entries: Record<string, { token: string; scale: bigint }> = {}): ChainAdapter {
    return {
        fetchAsset: vi.fn(async (id: bigint) => {
            const e = entries[id.toString()];
            if (!e) throw new Error(`fixture: no asset ${id}`);
            return { token: e.token, scale: e.scale, disabled: false };
        }),
    } as unknown as ChainAdapter;
}

describe("AssetRegistry", () => {
    it("resolves by id, address and symbol from the relayer's list", async () => {
        const r = new AssetRegistry({ chain: chain(), tokens: async () => TOKENS });

        expect((await r.resolve(2n)).symbol).toBe("USDC");
        expect((await r.resolve("USDC")).id).toBe(2n);
        expect((await r.resolve("usdc")).id).toBe(2n);
        expect((await r.resolve(TOKENS[1]!.token.toLowerCase())).id).toBe(2n);
    });

    it("carries decimals through, so human amounts are defined", async () => {
        const r = new AssetRegistry({ chain: chain(), tokens: async () => TOKENS });
        expect((await r.resolve("WETH")).decimals).toBe(18);
        expect((await r.resolve("WETH")).scale).toBe(1000000000000n);
    });

    /// A wallet with no relayer must keep working exactly as it did: ids come
    /// from the chain registry itself.
    it("falls back to the chain for an id the list does not carry", async () => {
        const c = chain({
            "9": { token: "0xCCcc000000000000000000000000000000000000", scale: 1n },
        });
        const r = new AssetRegistry({ chain: c, tokens: async () => TOKENS });

        expect((await r.resolve(9n)).id).toBe(9n);
        expect(c.fetchAsset).toHaveBeenCalledWith(9n);
    });

    /// There is nothing to enumerate a symbol against without a list, so this
    /// has to say so rather than report the symbol as merely unknown.
    it("explains that a symbol needs an asset list", async () => {
        const r = new AssetRegistry({ chain: chain() });
        await expect(r.resolve("WETH")).rejects.toThrow(/no asset list is available/);
    });

    it("names what it does know when a symbol misses", async () => {
        const r = new AssetRegistry({ chain: chain(), tokens: async () => TOKENS });
        await expect(r.resolve("DAI")).rejects.toThrow(/Known: USDC, WETH/);
    });

    /// A relayer that is briefly down must not leave the registry permanently
    /// empty — the list is retried, not cached as failed.
    it("retries a failed list load", async () => {
        let calls = 0;
        const tokens = async () => {
            calls += 1;
            if (calls === 1) throw new Error("relayer down");
            return TOKENS;
        };
        const r = new AssetRegistry({ chain: chain(), tokens });

        await expect(r.resolve("WETH")).rejects.toThrow(/no asset list is available/);
        expect((await r.resolve("WETH")).id).toBe(1n);
    });

    it("fetches the list once across many resolutions", async () => {
        const tokens = vi.fn(async () => TOKENS);
        const r = new AssetRegistry({ chain: chain(), tokens });

        await r.resolve("WETH");
        await r.resolve("USDC");
        await r.list();
        expect(tokens).toHaveBeenCalledTimes(1);
    });

    it("lists everything it knows, lowest id first", async () => {
        const r = new AssetRegistry({ chain: chain(), tokens: async () => TOKENS });
        expect((await r.list()).map((a) => a.id)).toEqual([1n, 2n]);
    });
});
