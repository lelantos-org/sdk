import type { PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { evmBlockNumber } from "./evm-block.js";

/** A client whose `eth_getBlockByNumber` returns exactly `block`. */
function clientReturning(block: unknown, calls: unknown[] = []): PublicClient {
    return {
        request: async (args: unknown) => {
            calls.push(args);
            return block;
        },
    } as unknown as PublicClient;
}

describe("evmBlockNumber", () => {
    // Real values: L2 block 495232834 on Arbitrum One reports l1BlockNumber
    // 25769577, and that is what MASP hashed into the deposit digest. Using the
    // L2 height reverts DigestMismatch on both flushBatch and cancelDeposit.
    it("returns the L1 height when the node reports one", async () => {
        const client = clientReturning({ l1BlockNumber: "0x1893669" });
        await expect(evmBlockNumber(client, 495_232_834n)).resolves.toBe(25_769_577n);
    });

    // Ethereum and OP-stack chains omit the field; the block's own height is
    // what the EVM reports, so the log's blockNumber was right all along.
    it("falls back to the block's own height when the field is absent", async () => {
        const client = clientReturning({ number: "0x2fbf3f3" });
        await expect(evmBlockNumber(client, 50_057_907n)).resolves.toBe(50_057_907n);
    });

    it("falls back when the node returns no block at all", async () => {
        const client = clientReturning(null);
        await expect(evmBlockNumber(client, 123n)).resolves.toBe(123n);
    });

    // A blank value must not BigInt-parse to 0: that would produce a digest
    // that silently never matches, which is the failure mode this whole module
    // exists to prevent.
    it("treats an empty l1BlockNumber as absent rather than zero", async () => {
        const client = clientReturning({ l1BlockNumber: "" });
        await expect(evmBlockNumber(client, 777n)).resolves.toBe(777n);
    });

    it("queries the requested block as a hex quantity", async () => {
        const calls: unknown[] = [];
        const client = clientReturning({ l1BlockNumber: "0x1" }, calls);
        await evmBlockNumber(client, 255n);
        expect(calls).toEqual([{ method: "eth_getBlockByNumber", params: ["0xff", false] }]);
    });
});
