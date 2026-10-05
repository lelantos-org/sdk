import { TransactionReceiptNotFoundError, WaitForTransactionReceiptTimeoutError } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { Hex32 } from "../../core/brand.js";
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

// `fetchNotePayload` is handed hashes from payment proofs, so a transaction that does not exist is
// an answer. `txReceiptLogs` is handed hashes of transactions believed mined, so it waits.
describe("ViemChainReader receipt reads for a hash the node does not know", () => {
    const TX = `0x${"7a".repeat(32)}` as Hex32;
    const CM = `0x${"0c".repeat(32)}` as Hex32;

    /** A reader whose client answers the receipt lookup with `lookup` and the wait with `wait`. */
    function readerOver(lookup: () => Promise<unknown>, wait: () => Promise<unknown>) {
        const reader = new ViemChainReader({ rpcUrl: "http://rpc.test", maspAddress: MASP });
        const client = {
            getTransactionReceipt: vi.fn(lookup),
            waitForTransactionReceipt: vi.fn(wait),
        };
        Object.assign(reader.publicClient, client);
        return { reader, client };
    }
    const notFound = async () => {
        throw new TransactionReceiptNotFoundError({ hash: TX });
    };
    const timedOut = async () => {
        throw new WaitForTransactionReceiptTimeoutError({ hash: TX });
    };

    it("fetchNotePayload: null, without the waiting call", async () => {
        const { reader, client } = readerOver(notFound, timedOut);

        await expect(reader.fetchNotePayload(TX, CM)).resolves.toBeNull();
        expect(client.getTransactionReceipt).toHaveBeenCalledExactlyOnceWith({ hash: TX });
        expect(client.waitForTransactionReceipt).not.toHaveBeenCalled();
    });

    it("fetchNotePayload: RPC_FAILED when the lookup fails in transport", async () => {
        const { reader } = readerOver(async () => {
            throw new TypeError("fetch failed");
        }, timedOut);

        await expect(reader.fetchNotePayload(TX, CM)).rejects.toMatchObject({
            code: "RPC_FAILED",
            method: "fetchNotePayload",
            retryable: true,
        });
    });

    it("txReceiptLogs: waits, and rejects TX_MINING when no receipt arrives", async () => {
        const { reader, client } = readerOver(notFound, timedOut);

        await expect(reader.txReceiptLogs(TX)).rejects.toMatchObject({
            code: "TX_MINING",
            retryable: true,
        });
        expect(client.waitForTransactionReceipt).toHaveBeenCalledOnce();
    });
});
