import { createPublicClient, custom } from "viem";
import { describe, expect, it } from "vitest";
import { assetId, branded, type EvmAddress } from "../../core/brand.js";
import { WireFormatError } from "../../errors/network.js";
import { RAY } from "../../protocol/units.js";
import type { ViemCtx } from "./ctx.js";
import { chainError } from "./errors.js";
import { fetchAssetYield } from "./reads.js";

const MASP = branded<EvmAddress>("0x0000000000000000000000000000000000000a11");
const VENUE = branded<EvmAddress>("0x000000000000000000000000000000000000e4ee");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ID = assetId(4n);

interface Call {
    address: string;
    functionName: string;
}

/**
 * A pool that answers `yieldState` with `state` and the venue with `lent`,
 * recording every read.
 */
function stubPool(state: unknown, lent?: bigint): { ctx: ViemCtx; calls: Call[] } {
    const calls: Call[] = [];
    const ctx = {
        maspAddress: MASP,
        publicClient: {
            readContract: async (args: Call) => {
                calls.push({ address: args.address, functionName: args.functionName });
                if (args.functionName !== "yieldState") return lent;
                return state;
            },
        },
    } as unknown as ViemCtx;
    return { ctx, calls };
}

const yieldingState = {
    venue: VENUE,
    bufferBps: 500,
    perfBps: 1000,
    halted: false,
    totalNormalized: 900n,
    accruedFeeNormalized: 100n,
    idle: 200n,
    lastIdx: RAY,
    index: 1_100n * (RAY / 1_000n),
};

describe("fetchAssetYield", () => {
    it("reports a plain id on a yield pool without pricing it", async () => {
        const { ctx, calls } = stubPool({ ...yieldingState, venue: ZERO_ADDRESS });

        // `RAY` and no rate, not the index the pool returns: nothing is
        // outstanding against an unbound venue.
        expect(await fetchAssetYield(ctx, ID)).toEqual({ index: RAY, yieldEnabled: false });
        // No venue, so no second call.
        expect(calls.map((c) => c.functionName)).toEqual(["yieldState"]);
    });

    it("prices a yield asset off gross and supply, not off the index", async () => {
        const { ctx, calls } = stubPool(yieldingState, 900n);

        expect(await fetchAssetYield(ctx, ID)).toEqual({
            index: yieldingState.index,
            yieldEnabled: true,
            // gross = venue holdings + pool idle balance.
            // supply = depositors' units plus the accrued performance fee's;
            // omitting the fee leg would price the rest above what the pool pays.
            rate: { gross: 1_100n, supply: 1_000n },
        });
        expect(calls).toEqual([
            { address: MASP, functionName: "yieldState" },
            { address: VENUE, functionName: "totalAssets" },
        ]);
    });
});

describe("fetchAssetYield failure handling", () => {
    /** A real viem client whose `eth_call` is answered by `onCall`, so errors are viem's own. */
    function viemPool(onCall: () => unknown): ViemCtx {
        const publicClient = createPublicClient({
            transport: custom(
                {
                    request: async ({ method }: { method: string }) => {
                        if (method !== "eth_call") throw new Error(`unexpected ${method}`);
                        return onCall();
                    },
                    // viem's own retries would only slow the failure cases down.
                },
                { retryCount: 0 },
            ),
        });
        return { maspAddress: MASP, publicClient } as unknown as ViemCtx;
    }

    it("propagates a revert instead of reading it as no-yield", async () => {
        const ctx = viemPool(() => {
            throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
        });
        await expect(fetchAssetYield(ctx, ID)).rejects.toThrow();
    });

    it("propagates a transport failure instead of reading it as no-yield", async () => {
        const ctx = viemPool(() => {
            throw new TypeError("fetch failed");
        });
        // Read as "no yield", a yield asset would be priced at RAY for the wallet's life.
        await expect(fetchAssetYield(ctx, ID)).rejects.toThrow(/fetch failed/);
    });

    it("propagates a rate limit", async () => {
        const ctx = viemPool(() => {
            throw Object.assign(new Error("Too Many Requests"), { code: 429 });
        });
        await expect(fetchAssetYield(ctx, ID)).rejects.toThrow();
    });
});

describe("chainError", () => {
    it("classifies what the viem adapter's calls throw", () => {
        const transport = Object.assign(new Error("fetch failed"), { name: "HttpRequestError" });
        expect(chainError("fetchAsset", transport)).toMatchObject({
            code: "RPC_FAILED",
            method: "fetchAsset",
            retryable: true,
            cause: transport,
        });

        const revert = Object.assign(new Error("reverted"), {
            name: "ContractFunctionRevertedError",
        });
        expect(chainError("fetchAsset", revert)).toMatchObject({
            code: "RPC_FAILED",
            retryable: false,
        });

        const timeout = Object.assign(new Error("timed out"), {
            name: "WaitForTransactionReceiptTimeoutError",
        });
        expect(chainError("submitDeposit", timeout)).toMatchObject({
            code: "TX_MINING",
            retryable: true,
        });

        expect(chainError("signPermit2", { code: 4001 }, "sign-permit")).toMatchObject({
            code: "USER_REJECTED",
            action: "sign-permit",
        });

        const typed = new WireFormatError("$.logs", "two logs");
        expect(chainError("fetchDepositEscrowed", typed)).toBe(typed);
    });
});
