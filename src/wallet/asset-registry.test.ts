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

    /// An absent rate is unknown, not zero. Defaulting it would quote a free
    /// withdrawal and under-report what the recipient actually receives, so the
    /// registry reads the pool instead.
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
        // Still listed: completing it from the pool is not the same as dropping
        // it, or the symbol would stop resolving until the indexer caught up.
        expect((await r.resolve("WETH")).id).toBe(1n);
    });

    /// The override is what a fixture or a fork uses when the pool's own rates
    /// are absent or wrong; it must win over both sources, not just one.
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

        // With no rates on the wire the override also spares the pool read.
        const missing = new AssetRegistry({ chain: c, tokens: async () => unpriced, feeBps: 500n });
        expect(await missing.resolve("WETH")).toMatchObject({
            depositBps: 500n,
            withdrawBps: 500n,
        });
        expect(c.fetchAsset).not.toHaveBeenCalled();
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

// The relayer publishes `gross` and `supply` alongside the index because the
// index it reports is FLOORED on chain: a charge sized through it can land
// under what the contract takes, and the Permit2 pull is then refused. The
// registry therefore has to carry the pair through, not just the index.
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

    // An asset with no venue prices at `scale` forever, and must not be given a
    // rate that would send it down the index branch.
    it("leaves a plain asset with no rate and no index", async () => {
        const reg = new AssetRegistry({ chain: chain(), tokens: async () => TOKENS });
        const a = await reg.resolve(1n);
        expect(a.yieldEnabled).toBe(false);
        expect(a.rate).toBeUndefined();
    });
});
