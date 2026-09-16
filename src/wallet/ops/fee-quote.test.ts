import { describe, expect, it } from "vitest";
import type { EstimateResponse } from "../../protocol/responses.js";
import { estimateOf } from "../../test-utils/estimate.js";
import { storedNote } from "../../test-utils/wallet.js";
import type { AssetInfo } from "../assets/index.js";
import { quoteFee } from "./fee-quote.js";

const WETH = {
    id: 1n,
    token: "0xa",
    scale: 1n,
    disabled: false,
    symbol: "WETH",
} as unknown as AssetInfo;
const USDC = {
    id: 2n,
    token: "0xb",
    scale: 1n,
    disabled: false,
    symbol: "USDC",
} as unknown as AssetInfo;

/** An id whose lookup fails in transport rather than resolving to "unregistered". */
const TRANSPORT_FAILURE = 77n;

function ctx(opts: { estimate?: EstimateResponse | undefined; balances?: Record<string, bigint> }) {
    const held = Object.entries(opts.balances ?? {}).map(([asset, value], i) =>
        storedNote(i.toString(16), value, { asset: BigInt(asset) }),
    );
    return {
        cfg: {
            chainId: 31337n,
            submitter: opts.estimate ? { estimate: async () => opts.estimate! } : {},
        },
        notes: { notes: held },
        assets: {
            async resolveVerified(ref: unknown) {
                const id = BigInt(ref as bigint);
                const hit = [WETH, USDC].find((a) => a.id === id);
                if (hit) return hit;
                if (id === TRANSPORT_FAILURE) throw new TypeError("fetch failed");
                // What the pool answers for an unregistered id: `asset(id)` reverts `UnknownAsset`.
                throw Object.assign(new Error(`unregistered ${id}`), {
                    name: "ContractFunctionExecutionError",
                    cause: Object.assign(new Error("UnknownAsset"), {
                        name: "ContractFunctionRevertedError",
                    }),
                });
            },
        },
    } as unknown as Parameters<typeof quoteFee>[0];
}

const RELAYER = "lelantos1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";

/** A relayer at `RELAYER` charging `amounts` per asset id. */
const estimate = (amounts: Record<string, bigint>) => estimateOf(RELAYER, amounts);

describe("quoteFee", () => {
    it("reports what each accepted asset costs and whether it is affordable", async () => {
        const c = ctx({
            estimate: estimate({ "1": 10n, "2": 25n }),
            balances: { "1": 100n, "2": 5n },
        });

        const { charged, payTo, options } = await quoteFee(c, "transfer");

        expect(charged).toBe(true);
        expect(payTo).toBe(RELAYER);
        expect(options.map((o) => [o.asset.symbol, o.amount, o.balance, o.affordable])).toEqual([
            ["WETH", 10n, 100n, true],
            // Quoted and held, but insufficient.
            ["USDC", 25n, 5n, false],
        ]);
    });

    it("treats an asset with no balance as unaffordable, not absent", async () => {
        const c = ctx({ estimate: estimate({ "2": 1n }) });
        const [only] = (await quoteFee(c, "transfer")).options;
        expect([only?.balance, only?.affordable]).toEqual([0n, false]);
    });

    /// A relayer that subsidises gas charges nothing, and `feeAsset` is ignored.
    it("reports no charge when the relayer publishes no fee address", async () => {
        const est = { ...estimate({ "1": 10n }) };
        delete (est as { shieldedFeeAddress?: string }).shieldedFeeAddress;
        expect(await quoteFee(ctx({ estimate: est }), "transfer")).toEqual({
            kind: "transfer",
            options: [],
            charged: false,
        });
    });

    it("reports no charge when the submitter cannot quote at all", async () => {
        expect(await quoteFee(ctx({}), "transfer")).toEqual({
            kind: "transfer",
            options: [],
            charged: false,
        });
    });

    /// Without a registry entry no fee note can be built, so the asset is not offered.
    it("drops an asset it cannot resolve", async () => {
        const c = ctx({ estimate: estimate({ "1": 10n, "99": 10n }) });
        const { options } = await quoteFee(c, "transfer");
        expect(options.map((o) => o.asset.id)).toEqual([1n]);
    });

    /// Dropping it would hide a payable option behind a transient RPC failure.
    it("surfaces a lookup that failed rather than found nothing", async () => {
        const c = ctx({ estimate: estimate({ "1": 10n, "77": 10n }) });
        await expect(quoteFee(c, "transfer")).rejects.toThrow("fetch failed");
    });
});

describe("quoteFee kinds", () => {
    it("prices the native-unwrap estimate for a native withdrawal", async () => {
        const kinds: string[] = [];
        const c = ctx({ estimate: estimate({ "1": 10n }) });
        (c.cfg.submitter as { estimate: unknown }).estimate = async (_: bigint, kind: string) => {
            kinds.push(kind);
            return estimate({ "1": 10n });
        };
        const q = await quoteFee(c, "withdraw", { native: true });
        expect(kinds).toEqual(["withdrawNative"]);
        expect(q.kind).toBe("withdraw");
        expect(q.options[0]).toMatchObject({ amount: 10n, baseUnits: 10n, balance: 0n });
    });

    it("leaves balance and affordability undefined for a deposit", async () => {
        const c = ctx({ estimate: estimate({ "1": 10n }), balances: { "1": 100n } });
        const [only] = (await quoteFee(c, "deposit")).options;
        expect(only).toMatchObject({ balance: undefined, affordable: undefined, amount: 10n });
    });

    it("refuses an unknown kind", async () => {
        await expect(quoteFee(ctx({}), "teleport" as "transfer")).rejects.toMatchObject({
            code: "INVALID_ARGUMENT",
            argument: "kind",
        });
    });
});
