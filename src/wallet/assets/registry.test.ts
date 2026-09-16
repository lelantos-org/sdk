import { describe, expect, it, vi } from "vitest";
import type { ChainAdapter } from "../../chain/port.js";
import { WireFormatError } from "../../errors/network.js";
import type { ChainToken } from "../../protocol/responses.js";
import { AssetRegistry, VERIFIED_ASSET_TTL_MS } from "./registry.js";

const TOKENS: ChainToken[] = [
    {
        assetId: 1,
        token: "0xAAaa000000000000000000000000000000000000",
        scale: "1000000000000",
        symbol: "WETH",
        decimals: 18,
        depositBps: 25,
        withdrawBps: 30,
    },
    {
        assetId: 2,
        token: "0xBBbb000000000000000000000000000000000000",
        scale: "1",
        symbol: "USDC",
        decimals: 6,
        depositBps: 10,
        withdrawBps: 20,
    },
];

type Entry = { token: string; scale: bigint; depositBps?: bigint; withdrawBps?: bigint };

function chain(entries: Record<string, Entry> = {}): ChainAdapter {
    return {
        fetchAsset: vi.fn(async (id: bigint) => {
            const e = entries[id.toString()];
            if (!e) throw new Error(`fixture: no asset ${id}`);
            return {
                token: e.token,
                scale: e.scale,
                disabled: false,
                depositBps: e.depositBps ?? 0n,
                withdrawBps: e.withdrawBps ?? 0n,
            };
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

    it("carries both fee rates from the list, which the two legs price apart", async () => {
        const r = new AssetRegistry({ chain: chain(), tokens: async () => TOKENS });
        const weth = await r.resolve("WETH");
        expect(weth.depositBps).toBe(25n);
        expect(weth.withdrawBps).toBe(30n);
    });

    /// An absent rate is unknown, not zero, so the registry reads it from the pool.
    it("reads the pool for a token whose rates the relayer has not indexed", async () => {
        const [weth] = TOKENS;
        const { depositBps: _d, withdrawBps: _w, ...unpricedWeth } = weth!;
        const unpriced: ChainToken[] = [unpricedWeth];
        const c = chain({
            "1": { token: weth!.token, scale: 1_000_000_000_000n, depositBps: 7n, withdrawBps: 9n },
        });
        const r = new AssetRegistry({ chain: c, tokens: async () => unpriced });

        const info = await r.resolve(1n);
        expect(info.depositBps).toBe(7n);
        expect(info.withdrawBps).toBe(9n);
        expect(c.fetchAsset).toHaveBeenCalledWith(1n);
        // The entry stays listed, so the symbol still resolves.
        expect((await r.resolve("WETH")).id).toBe(1n);
    });

    /// Fixtures and forks use the override when the pool's rates are absent or
    /// wrong; it takes precedence over both sources.
    it("lets `feeBps` replace the rates from either source", async () => {
        const [weth] = TOKENS;
        const { depositBps: _d, withdrawBps: _w, ...unpricedWeth } = weth!;
        const unpriced: ChainToken[] = [unpricedWeth];
        const c = chain({ "1": { token: weth!.token, scale: 1n } });

        const listed = new AssetRegistry({
            chain: c,
            tokens: async () => TOKENS,
            feeBps: { depositBps: 1n, withdrawBps: 2n },
        });
        expect(await listed.resolve("WETH")).toMatchObject({ depositBps: 1n, withdrawBps: 2n });

        // With no rates on the wire, the override also skips the pool read.
        const missing = new AssetRegistry({ chain: c, tokens: async () => unpriced, feeBps: 500n });
        expect(await missing.resolve("WETH")).toMatchObject({
            depositBps: 500n,
            withdrawBps: 500n,
        });
        expect(c.fetchAsset).not.toHaveBeenCalled();
    });

    /// Without a relayer, ids resolve from the chain registry.
    it("falls back to the chain for an id the list does not carry", async () => {
        const c = chain({
            "9": { token: "0xCCcc000000000000000000000000000000000000", scale: 1n },
        });
        const r = new AssetRegistry({ chain: c, tokens: async () => TOKENS });

        expect((await r.resolve(9n)).id).toBe(9n);
        expect(c.fetchAsset).toHaveBeenCalledWith(9n);
    });

    /// Without a list a symbol cannot be resolved; the error states the cause.
    it("explains that a symbol needs an asset list", async () => {
        const r = new AssetRegistry({ chain: chain() });
        await expect(r.resolve("WETH")).rejects.toThrow(/no asset list is available/);
    });

    it("names what it does know when a symbol misses", async () => {
        const r = new AssetRegistry({ chain: chain(), tokens: async () => TOKENS });
        await expect(r.resolve("DAI")).rejects.toThrow(/Known: USDC, WETH/);
    });

    /// A transient relayer outage must not leave the registry permanently empty.
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

    /// A failed read must not become the cached answer for the wallet's lifetime.
    it("does not cache an asset whose token metadata read failed", async () => {
        let metaCalls = 0;
        const c = {
            fetchAsset: vi.fn(async () => ({
                token: "0xCCcc000000000000000000000000000000000000",
                scale: 1n,
                disabled: false,
                depositBps: 0n,
                withdrawBps: 0n,
            })),
            tokenMeta: vi.fn(async () => {
                if (metaCalls++ === 0) throw new TypeError("fetch failed");
                return { symbol: "DAI", decimals: 18 };
            }),
        } as unknown as ChainAdapter;
        const r = new AssetRegistry({ chain: c });

        // Built without `decimals`, the entry would carry a different ladder and never be re-read.
        await expect(r.resolve(9n)).rejects.toThrow(/fetch failed/);
        const info = await r.resolve(9n);
        expect(info.decimals).toBe(18);
        expect(info.symbol).toBe("DAI");
    });

    it("still resolves a token that refuses symbol()/decimals()", async () => {
        const c = {
            fetchAsset: vi.fn(async () => ({
                token: "0xCCcc000000000000000000000000000000000000",
                scale: 1n,
                disabled: false,
                depositBps: 0n,
                withdrawBps: 0n,
            })),
            tokenMeta: vi.fn(async () => {
                throw Object.assign(new Error("reverted"), {
                    name: "ContractFunctionExecutionError",
                    cause: Object.assign(new Error("no data"), {
                        name: "ContractFunctionZeroDataError",
                    }),
                });
            }),
        } as unknown as ChainAdapter;
        const r = new AssetRegistry({ chain: c });

        const info = await r.resolve(9n);
        expect(info.decimals).toBeUndefined();
        // Cached: a token without the getters is not re-read on every resolve.
        await r.resolve(9n);
        expect(c.fetchAsset).toHaveBeenCalledTimes(1);
    });

    it("does not cache an asset whose yield probe failed", async () => {
        let calls = 0;
        const c = {
            fetchAsset: vi.fn(async () => {
                // The reader folds the yield probe into `fetchAsset`; a transport failure there
                // now propagates instead of reading as "no yield".
                if (calls++ === 0) throw new TypeError("fetch failed");
                return {
                    token: "0xCCcc000000000000000000000000000000000000",
                    scale: 1n,
                    disabled: false,
                    depositBps: 0n,
                    withdrawBps: 0n,
                    index: 2n * 10n ** 27n,
                    yieldEnabled: true,
                    rate: { gross: 2n, supply: 1n },
                };
            }),
        } as unknown as ChainAdapter;
        const r = new AssetRegistry({ chain: c });

        await expect(r.resolve(9n)).rejects.toThrow(/fetch failed/);
        expect((await r.resolve(9n)).yieldEnabled).toBe(true);
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

// The relayer publishes `gross` and `supply` alongside the index because the on-chain index is
// floored: a charge sized from it can fall short of what the contract takes, causing the Permit2
// pull to be refused. The registry must carry the pair, not only the index.
describe("AssetRegistry yield state", () => {
    const YIELDING: ChainToken[] = [
        {
            assetId: 9,
            token: "0xDDdd000000000000000000000000000000000000",
            scale: "1",
            symbol: "USDC",
            decimals: 6,
            depositBps: 20,
            withdrawBps: 20,
            yieldState: {
                venue: "0xEEee000000000000000000000000000000000000",
                gross: "1100000",
                supply: "1000000",
                index: "1100000000000000000000000000",
                halted: false,
            },
        },
    ];

    it("carries the exact rate, not only the reported index", async () => {
        const reg = new AssetRegistry({ chain: chain(), tokens: async () => YIELDING });
        const a = await reg.resolve(9n);
        expect(a.yieldEnabled).toBe(true);
        expect(a.index).toBe(1_100_000_000_000_000_000_000_000_000n);
        expect(a.rate).toEqual({ gross: 1_100_000n, supply: 1_000_000n });
    });

    // An asset with no venue prices at `scale` and must not get a rate, which
    // would route it through the index branch.
    it("leaves a plain asset with no rate and no index", async () => {
        const reg = new AssetRegistry({ chain: chain(), tokens: async () => TOKENS });
        const a = await reg.resolve(1n);
        expect(a.yieldEnabled).toBe(false);
        expect(a.rate).toBeUndefined();
    });
});

// The list maps names to ids; value-bearing fields come from the pool, and a list that
// contradicts the pool is refused rather than silently corrected in either direction.
describe("AssetRegistry.resolveVerified", () => {
    const [WETH_T, USDC_T] = TOKENS as [ChainToken, ChainToken];
    const honest = () =>
        chain({
            "1": {
                token: WETH_T.token,
                scale: 1_000_000_000_000n,
                depositBps: 5n,
                withdrawBps: 6n,
            },
            "2": { token: USDC_T.token.toLowerCase(), scale: 1n },
        });

    it("reads token, scale and fees from the chain and keeps the list's symbol and decimals", async () => {
        const c = honest();
        const r = new AssetRegistry({ chain: c, tokens: async () => TOKENS });

        const weth = await r.resolveVerified("WETH");
        expect(c.fetchAsset).toHaveBeenCalledWith(1n);
        // The list advertises 25/30 bps; the pool's rates win.
        expect(weth).toMatchObject({ id: 1n, depositBps: 5n, withdrawBps: 6n, decimals: 18 });
        expect(weth.symbol).toBe("WETH");
        // Advisory `resolve` still returns the list's claim.
        expect((await r.resolve("WETH")).depositBps).toBe(25n);
    });

    it("takes the yield index and rate from the chain, not the relayer", async () => {
        const c = {
            fetchAsset: vi.fn(async () => ({
                token: "0xDDdd000000000000000000000000000000000000",
                scale: 1n,
                disabled: false,
                depositBps: 0n,
                withdrawBps: 0n,
                index: 3n * 10n ** 27n,
                yieldEnabled: true,
                rate: { gross: 3n, supply: 1n },
            })),
        } as unknown as ChainAdapter;
        const stale: ChainToken = {
            assetId: 9,
            token: "0xDDdd000000000000000000000000000000000000",
            scale: "1",
            symbol: "yUSDC",
            decimals: 6,
            depositBps: 0,
            withdrawBps: 0,
            yieldState: {
                venue: "0xEEee000000000000000000000000000000000000",
                gross: "1",
                supply: "1",
                index: (10n ** 27n).toString(),
                halted: false,
            },
        };
        const r = new AssetRegistry({ chain: c, tokens: async () => [stale] });
        const a = await r.resolveVerified("yUSDC");
        expect(a.index).toBe(3n * 10n ** 27n);
        expect(a.rate).toEqual({ gross: 3n, supply: 1n });
    });

    it.each([
        ["token", { token: "0xdead000000000000000000000000000000000000", scale: 1n }],
        ["scale", { token: USDC_T.token, scale: 1_000n }],
    ])("refuses a list whose %s contradicts the chain", async (field, entry) => {
        const c = chain({ "2": entry });
        const r = new AssetRegistry({ chain: c, tokens: async () => TOKENS });
        const err = await r.resolveVerified("USDC").catch((e: unknown) => e);
        expect(err).toBeInstanceOf(WireFormatError);
        expect(err).toMatchObject({ code: "WIRE_FORMAT", details: { asset: "2", field } });
    });

    it("refuses listed decimals the token contradicts", async () => {
        const c = Object.assign(honest(), {
            tokenMeta: vi.fn(async () => ({ symbol: "USDC", decimals: 18 })),
        });
        const r = new AssetRegistry({ chain: c, tokens: async () => TOKENS });
        await expect(r.resolveVerified(2n)).rejects.toMatchObject({
            code: "WIRE_FORMAT",
            details: { field: "decimals" },
        });
    });

    /// The list maps the name to an id whose on-chain token is another asset.
    it("refuses a symbol or address the list redirects to another asset", async () => {
        const redirect: ChainToken[] = [{ ...USDC_T, token: WETH_T.token, assetId: 1 }];
        const c = Object.assign(honest(), {
            tokenMeta: vi.fn(async (t: string) =>
                t.toLowerCase() === WETH_T.token.toLowerCase()
                    ? { symbol: "WETH", decimals: 6 }
                    : { symbol: "USDC", decimals: 6 },
            ),
        });
        // Scale kept consistent so only the name is wrong.
        const listed = [{ ...redirect[0]!, scale: "1000000000000" }];
        const r = new AssetRegistry({ chain: c, tokens: async () => listed });
        await expect(r.resolveVerified("USDC")).rejects.toMatchObject({
            code: "WIRE_FORMAT",
            details: { field: "symbol" },
        });
    });

    it("refuses an address ref the list maps to an id holding a different token", async () => {
        const c = chain({
            "2": { token: "0xdead000000000000000000000000000000000000", scale: 1n },
        });
        const r = new AssetRegistry({ chain: c, tokens: async () => TOKENS });
        await expect(r.resolveVerified(USDC_T.token)).rejects.toMatchObject({
            code: "WIRE_FORMAT",
            details: { field: "token" },
        });
    });

    it("reuses a verified entry briefly, then re-reads the chain", async () => {
        vi.useFakeTimers();
        try {
            const c = honest();
            const r = new AssetRegistry({ chain: c, tokens: async () => TOKENS });
            await Promise.all([r.resolveVerified(2n), r.resolveVerified("USDC")]);
            expect(c.fetchAsset).toHaveBeenCalledTimes(1);

            vi.advanceTimersByTime(VERIFIED_ASSET_TTL_MS);
            await r.resolveVerified(2n);
            expect(c.fetchAsset).toHaveBeenCalledTimes(2);

            await r.refresh(2n);
            expect(c.fetchAsset).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not cache a failed chain read", async () => {
        let calls = 0;
        const c = {
            fetchAsset: vi.fn(async () => {
                if (calls++ === 0) throw new TypeError("fetch failed");
                return {
                    token: USDC_T.token,
                    scale: 1n,
                    disabled: false,
                    depositBps: 0n,
                    withdrawBps: 0n,
                };
            }),
        } as unknown as ChainAdapter;
        const r = new AssetRegistry({ chain: c, tokens: async () => TOKENS });
        await expect(r.resolveVerified(2n)).rejects.toThrow(/fetch failed/);
        expect((await r.resolveVerified(2n)).scale).toBe(1n);
    });

    it("keeps a caller's feeBps override over the pool's rates", async () => {
        const r = new AssetRegistry({ chain: honest(), tokens: async () => TOKENS, feeBps: 7n });
        expect(await r.resolveVerified("WETH")).toMatchObject({ depositBps: 7n, withdrawBps: 7n });
    });
});
