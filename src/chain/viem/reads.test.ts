import { describe, expect, it } from "vitest";
import { assetId, branded, type EvmAddress } from "../../core/brand.js";
import { RAY } from "../../core/units.js";
import type { ViemCtx } from "./ctx.js";
import { fetchAssetYield } from "./reads.js";

// A pool that predates the yield mixin has no `yieldState` selector, and every
// asset on it is a plain one. That reverting call is the only signal there is,
// so it has to read as "no yield" rather than as a failed asset fetch —
// otherwise the SDK stops working against every pool deployed so far.

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
 * recording every read. A `state` of `undefined` is the pre-mixin pool: the
 * selector is not there, so the call reverts.
 */
function stubPool(state: unknown, lent?: bigint): { ctx: ViemCtx; calls: Call[] } {
    const calls: Call[] = [];
    const ctx = {
        maspAddress: MASP,
        publicClient: {
            readContract: async (args: Call) => {
                calls.push({ address: args.address, functionName: args.functionName });
                if (args.functionName !== "yieldState") return lent;
                if (state === undefined) throw new Error("execution reverted: no such function");
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
    it("reads as no-yield when the pool has no mixin", async () => {
        const { ctx, calls } = stubPool(undefined);

        expect(await fetchAssetYield(ctx, ID)).toBeUndefined();
        // The revert is the answer; nothing follows it.
        expect(calls).toHaveLength(1);
    });

    it("reports a plain id on a yield pool without pricing it", async () => {
        const { ctx, calls } = stubPool({ ...yieldingState, venue: ZERO_ADDRESS });

        // `RAY` and no rate, not the index the pool happened to return: nothing
        // is outstanding against a venue that was never bound.
        expect(await fetchAssetYield(ctx, ID)).toEqual({ index: RAY, yieldEnabled: false });
        // No venue to ask, so the second call is not made.
        expect(calls.map((c) => c.functionName)).toEqual(["yieldState"]);
    });

    it("prices a yield asset off gross and supply, not off the index", async () => {
        const { ctx, calls } = stubPool(yieldingState, 900n);

        expect(await fetchAssetYield(ctx, ID)).toEqual({
            index: yieldingState.index,
            yieldEnabled: true,
            // gross = what the venue holds + what the pool held back.
            // supply = the depositors' units *and* the accrued performance fee's;
            // dropping the fee leg would price the rest above what the pool pays.
            rate: { gross: 1_100n, supply: 1_000n },
        });
        expect(calls).toEqual([
            { address: MASP, functionName: "yieldState" },
            { address: VENUE, functionName: "totalAssets" },
        ]);
    });
});
