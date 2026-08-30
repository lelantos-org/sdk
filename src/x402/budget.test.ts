import { describe, expect, it } from "vitest";
import { assetId, branded, type CircuitAmount, evmAddress } from "../core/brand.js";
import type { AssetInfoWithMeta } from "../wallet/assets.js";
import { makeAssetInfo, requireTokenMeta } from "../wallet/assets.js";
import { BudgetLedger } from "./budget.js";

/** scale 10^15 → one circuit unit is 0.001 of an 18-decimal token. */
const WETH = requireTokenMeta(
    makeAssetInfo({
        id: assetId(1n),
        token: evmAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
        scale: 10n ** 15n,
        symbol: "WETH",
        decimals: 18,
    }),
);

const USDC = requireTokenMeta(
    makeAssetInfo({
        id: assetId(2n),
        token: evmAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        scale: 10n ** 3n,
        symbol: "USDC",
        decimals: 6,
    }),
);

/** `n` whole tokens in circuit units. */
const whole = (n: bigint, asset: AssetInfoWithMeta): CircuitAmount =>
    branded<CircuitAmount>((n * 10n ** BigInt(asset.decimals)) / asset.scale);

describe("BudgetLedger hosts", () => {
    it("allows any host when unset", () => {
        const l = new BudgetLedger({ total: "5" });
        expect(() => l.assertHostAllowed("https://anything.example/x")).not.toThrow();
    });

    it("permits a listed host and refuses others", () => {
        const l = new BudgetLedger({ total: "5" }, ["api.example.com"]);
        expect(() => l.assertHostAllowed("https://api.example.com/v1/x")).not.toThrow();
        expect(() => l.assertHostAllowed("https://evil.example.com/v1/x")).toThrow(
            /not in allowHosts/,
        );
    });

    it("matches host case-insensitively but ignores path and port-free authority only", () => {
        const l = new BudgetLedger({ total: "5" }, ["API.Example.com"]);
        expect(() => l.assertHostAllowed("https://api.example.COM/deep/path?q=1")).not.toThrow();
    });

    it("refuses a malformed URL rather than defaulting to allow", () => {
        const l = new BudgetLedger({ total: "5" }, ["api.example.com"]);
        expect(() => l.assertHostAllowed("not a url")).toThrow(/not a valid URL/);
    });
});

describe("BudgetLedger limits", () => {
    it("accepts a payment inside both limits", () => {
        const l = new BudgetLedger({ total: "5", perRequest: "1" });
        expect(() => l.assertWithinLimits(whole(1n, WETH), WETH)).not.toThrow();
    });

    it("rejects a single payment over perRequest", () => {
        const l = new BudgetLedger({ total: "5", perRequest: "1" });
        expect(() => l.assertWithinLimits(whole(2n, WETH), WETH)).toThrow(/per-request limit/);
    });

    it("defaults perRequest to total", () => {
        const l = new BudgetLedger({ total: "1" });
        expect(() => l.assertWithinLimits(whole(2n, WETH), WETH)).toThrow(/per-request limit/);
    });

    it("accumulates toward total across payments", () => {
        const l = new BudgetLedger({ total: "3", perRequest: "2" });
        const two = whole(2n, WETH);
        l.assertWithinLimits(two, WETH);
        l.record(two, WETH.id);
        expect(() => l.assertWithinLimits(two, WETH)).toThrow(/over the budget/);
    });

    it("keeps assets in separate pots", () => {
        const l = new BudgetLedger({ total: "5" });
        l.record(whole(5n, WETH), WETH.id);
        // WETH is exhausted...
        expect(() => l.assertWithinLimits(whole(1n, WETH), WETH)).toThrow(/over the budget/);
        // ...but USDC has its own ceiling.
        expect(() => l.assertWithinLimits(whole(5n, USDC), USDC)).not.toThrow();
    });

    it("reports spend per asset", () => {
        const l = new BudgetLedger({ total: "5" });
        l.record(whole(1n, WETH), WETH.id);
        l.record(whole(2n, USDC), USDC.id);
        expect(l.spent()).toEqual(
            new Map([
                [1n, whole(1n, WETH)],
                [2n, whole(2n, USDC)],
            ]),
        );
    });

    it("returns a copy so callers cannot mutate the ledger", () => {
        const l = new BudgetLedger({ total: "5" });
        l.record(whole(1n, WETH), WETH.id);
        l.spent().set(1n, 0n);
        expect(l.spent().get(1n)).toBe(whole(1n, WETH));
    });

    it("names the asset in the message when decimals are known", () => {
        const l = new BudgetLedger({ total: "1" });
        expect(() => l.assertWithinLimits(whole(2n, WETH), WETH)).toThrow(/2 WETH/);
    });
});
