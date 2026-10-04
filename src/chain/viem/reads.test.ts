import { createPublicClient, custom, encodeAbiParameters, pad, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { assetId, branded, type EvmAddress } from "../../core/brand.js";
import { WireFormatError } from "../../errors/network.js";
import { RAY } from "../../protocol/units.js";
import type { ViemCtx } from "./ctx.js";
import { chainError } from "./errors.js";
import { fetchAsset, fetchAssetYield, fetchDepositEscrowed } from "./reads.js";

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

/**
 * A real viem client answering each JSON-RPC method from `handlers`, so the calldata, the log
 * filter and the decode are viem's own over `MASP_ABI`.
 *
 * What the node returns is laid out by hand from the Solidity declarations, never from that ABI:
 * a member the SDK's copy drops, misorders or mistypes then fails here instead of round-tripping.
 */
function rpcPool(handlers: Record<string, (params: readonly unknown[]) => unknown>): ViemCtx {
    const publicClient = createPublicClient({
        transport: custom(
            {
                request: async ({ method, params }: { method: string; params: unknown[] }) => {
                    const handler = handlers[method];
                    if (!handler) throw new Error(`unexpected ${method}`);
                    return handler(params);
                },
            },
            { retryCount: 0 },
        ),
    });
    return { maspAddress: MASP, publicClient } as unknown as ViemCtx;
}

/** ABI-encode `members`, each a Solidity type and its value, in order. */
const encodeMembers = (members: readonly (readonly [type: string, value: unknown])[]) =>
    encodeAbiParameters(
        members.map(([type]) => ({ type })),
        members.map(([, value]) => value) as never,
    );

describe("fetchAsset", () => {
    // No letters, so viem's checksum casing leaves it as written.
    const TOKEN = branded<EvmAddress>("0x0000000000000000000000000000000000001234");

    /** `AssetRegistry.AssetEntry`: one storage slot, six words on the wire. */
    const entryWords = (e: { disabled: boolean; isYield: boolean; scale: bigint }) =>
        encodeMembers([
            ["address", TOKEN],
            ["bool", e.disabled],
            ["uint16", 20],
            ["uint16", 30],
            ["bool", e.isYield],
            ["uint48", e.scale],
        ]);

    it.each([
        ["a plain asset", { disabled: false, isYield: false, scale: 10n ** 12n }],
        // The widest scale the registry stores, with both flags set.
        ["a yield asset", { disabled: true, isYield: true, scale: (1n << 48n) - 1n }],
    ])("decodes %s's entry, its uint48 scale as a bigint", async (_, onChain) => {
        const calls: { data: string }[] = [];
        const ctx = rpcPool({
            eth_call: ([call]) => {
                calls.push(call as { data: string });
                return entryWords(onChain);
            },
        });

        const entry = await fetchAsset(ctx, ID);

        // `toEqual` tells `10n` from `10`: viem hands a uint48 back as a JS number, and `scale`
        // must be a bigint. `isYield` stays out of the entry; `fetchAssetYield` reports the same
        // fact as `yieldEnabled`.
        expect(entry).toEqual({
            token: TOKEN,
            scale: onChain.scale,
            disabled: onChain.disabled,
            depositBps: 20n,
            withdrawBps: 30n,
        });
        // `asset(uint64)`: the entry's layout is not part of the selector.
        expect(calls.map((c) => c.data)).toEqual([`0x5a56d8c3${pad(toHex(ID)).slice(2)}`]);
    });
});

describe("fetchDepositEscrowed", () => {
    // `keccak256` of the `DepositEscrowed` signature.
    const TOPIC = "0x48786aa9d3678601a40c373a6118f7b062456414dee7cf289e46a81059fcbe57";
    const PAYER = "0x0000000000000000000000000000000000000011";
    const RECIPIENT = "0x0000000000000000000000000000000000000022";
    const INNER = `0x${"22".repeat(32)}`;
    const FEE_INNER = `0x${"44".repeat(32)}`;
    const BLOCK_HASH = `0x${"bb".repeat(32)}`;

    /** `DepositEscrowed` as a node returns it: three indexed topics, then the body in order. */
    const escrowedLog = (id: bigint, pulled: bigint) => ({
        address: MASP,
        topics: [TOPIC, pad(toHex(id)), pad(PAYER), pad(RECIPIENT)],
        data: encodeMembers([
            ["uint64", 4n], // publicAssetId
            ["uint64", 250n], // publicIn
            ["uint16", 20], // feeBpsAtSubmit
            ["bytes32", INNER],
            ["uint256", 1n], // clueR
            ["uint256", 2n],
            ["uint256", 3n], // ephPub
            ["uint256", 4n],
            ["bytes", "0x0000dead"], // ciphertext
            ["uint64", 2n], // feeAssetId
            ["uint64", 5n], // feeIn
            ["bytes32", FEE_INNER],
            ["uint256", 5n], // feeClueR
            ["uint256", 6n],
            ["uint256", 7n], // feeEphPub
            ["uint256", 8n],
            ["bytes", "0x0000beef"], // feeCiphertext
            ["uint256", pulled],
        ]),
        blockNumber: "0x4d",
        blockHash: BLOCK_HASH,
        transactionHash: BLOCK_HASH,
        transactionIndex: "0x0",
        logIndex: "0x0",
        removed: false,
    });

    it.each([
        ["zero for a plain asset", 0n],
        ["the amount pulled for a yield asset", 2_513n],
    ])("decodes the escrow with its refund cap: %s", async (_, pulled) => {
        const filters: { topics: unknown[] }[] = [];
        const ctx = rpcPool({
            eth_getLogs: ([filter]) => {
                filters.push(filter as { topics: unknown[] });
                return [escrowedLog(42n, pulled)];
            },
            // No `l1BlockNumber`: the EVM's `block.number` is the log's.
            eth_getBlockByNumber: () => ({}),
        });

        expect(await fetchDepositEscrowed(ctx, 42n, 1n)).toEqual({
            id: 42n,
            payer: PAYER,
            recipient: RECIPIENT,
            publicAssetId: 4n,
            publicIn: 250n,
            feeBpsAtSubmit: 20,
            inner: INNER,
            feeIn: 5n,
            feeAssetId: 2n,
            feeInner: FEE_INNER,
            pulled,
            submittedAt: 77,
        });
        // The node is asked for this topic and this id, any payer and recipient: a topic from
        // another signature matches no deposit, and the escrow reads as absent.
        expect(filters.map((f) => f.topics)).toEqual([[TOPIC, pad(toHex(42n)), null, null]]);
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
