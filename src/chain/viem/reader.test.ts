import { describe, expect, it, vi } from "vitest";
import { ViemChainReader } from "./reader.js";

// The spend cooldown and the consolidation wait compare notes against the chain tip, so a tip
// served from viem's block-number cache (4s by default) makes both act on stale state.

const MASP = "0x0000000000000000000000000000000000000a11";

/** An RPC endpoint answering `eth_blockNumber` with an advancing height, counting requests. */
function rpc() {
    let height = 100;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as
            | { id: number; method: string }
            | { id: number; method: string }[];
        const answer = (req: { id: number; method: string }) => ({
            jsonrpc: "2.0",
            id: req.id,
            result: `0x${(height++).toString(16)}`,
        });
        const out = Array.isArray(body) ? body.map(answer) : answer(body);
        return new Response(JSON.stringify(out), {
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;
    return fetchImpl;
}

describe("ViemChainReader block number", () => {
    it("reads the tip afresh on every call by default", async () => {
        const fetchImpl = rpc();
        const reader = new ViemChainReader({
            rpcUrl: "http://rpc.test",
            maspAddress: MASP,
            fetch: fetchImpl,
        });

        const first = await reader.blockNumber();
        const second = await reader.blockNumber();

        expect(second).toBeGreaterThan(first);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("caches the tip when asked to", async () => {
        const fetchImpl = rpc();
        const reader = new ViemChainReader({
            rpcUrl: "http://rpc.test",
            maspAddress: MASP,
            fetch: fetchImpl,
            cacheTimeMs: 60_000,
        });

        const first = await reader.blockNumber();
        const second = await reader.blockNumber();

        expect(second).toBe(first);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
