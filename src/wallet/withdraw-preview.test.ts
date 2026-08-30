import { describe, expect, it } from "vitest";
import { assetId, evmAddress } from "../core/brand.js";
import { RAY } from "../core/units.js";
import { makeAssetInfo, requireTokenMeta } from "./assets.js";
import { denominationChoices, previewWithdraw } from "./withdraw-preview.js";

const BPS = 20n; // 0.2%, the deployed rate

// Built through the factory rather than as a literal, so the ladder is derived
// from the address the way production derives it and the fixture cannot drift.
const USDC = requireTokenMeta(
    makeAssetInfo({
        id: assetId(2n),
        token: evmAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        scale: 1n,
        symbol: "USDC",
        decimals: 6,
    }),
);

/** An asset the built-in table does not cover — no ladder to conform to. */
const NO_LADDER = requireTokenMeta(
    makeAssetInfo({
        id: assetId(9n),
        token: evmAddress("0x000000000000000000000000000000000000dEaD"),
        scale: 1n,
        symbol: "XYZ",
        decimals: 6,
    }),
);

describe("previewWithdraw", () => {
    it("separates the gross published on chain from what the recipient gets", () => {
        // The distinction the API exists to make visible: `amount` is the
        // gross, and the recipient always receives less.
        const p = previewWithdraw({ amount: "1000", asset: USDC, feeBps: BPS });
        expect(p.publicOut).toBe(1_000_000_000n);
        expect(p.net).toBe(998_000_000n);
        expect(p.fee).toBe(2_000_000n);
        expect(p.netFormatted).toBe("998");
        expect(p.net).toBeLessThan(p.publicOut);
    });

    it("accounts for every unit: net + fee is the gross", () => {
        const p = previewWithdraw({ amount: "1000", asset: USDC, feeBps: BPS });
        expect(p.net + p.fee).toBe(p.publicOut * USDC.scale);
    });

    it("flags an on-ladder amount and suggests nothing", () => {
        const p = previewWithdraw({ amount: "1000", asset: USDC, feeBps: BPS });
        expect(p.onLadder).toBe(true);
        expect(p.hasLadder).toBe(true);
        expect(p.suggestion).toBeUndefined();
    });

    it("flags an off-ladder amount and points at the nearest denomination", () => {
        // Not an error and nothing rejects it — but it publishes a near-unique
        // integer, so the caller has to be told.
        const p = previewWithdraw({ amount: "1337", asset: USDC, feeBps: BPS });
        expect(p.onLadder).toBe(false);
        expect(p.suggestion).toBe(1_000_000_000n);
    });

    it("reports no ladder rather than pretending everything is off it", () => {
        const p = previewWithdraw({ amount: "1337", asset: NO_LADDER, feeBps: BPS });
        expect(p.hasLadder).toBe(false);
        expect(p.onLadder).toBe(false);
        expect(p.suggestion).toBeUndefined();
        expect(p.denominations).toEqual([]);
    });

    it("grows the net with the yield index, the denomination unchanged", () => {
        const yielding = requireTokenMeta(
            makeAssetInfo({
                id: USDC.id,
                token: USDC.token,
                scale: USDC.scale,
                decimals: USDC.decimals,
                index: (RAY * 105n) / 100n,
                yieldEnabled: true,
            }),
        );
        const flat = previewWithdraw({ amount: 1_000_000_000n, asset: USDC, feeBps: 0n });
        const grown = previewWithdraw({ amount: 1_000_000_000n, asset: yielding, feeBps: 0n });
        expect(grown.net).toBe((flat.net * 105n) / 100n);
        expect(grown.publicOut).toBe(flat.publicOut);
        expect(grown.onLadder).toBe(true);
    });

    it("takes the fee rate as an argument, so a UI can call it per keystroke", () => {
        expect(previewWithdraw({ amount: "1000", asset: USDC, feeBps: 0n }).net).toBe(
            1_000_000_000n,
        );
        expect(previewWithdraw({ amount: "1000", asset: USDC, feeBps: 2_000n }).net).toBe(
            800_000_000n,
        );
    });
});

describe("denominationChoices", () => {
    it("labels every denomination with its gross and its net", () => {
        const choices = denominationChoices(USDC, BPS);
        expect(choices).toHaveLength(13);
        expect(choices[0]).toEqual({ value: 10_000_000n, label: "10", netLabel: "9.98" });
        expect(choices.at(-1)).toEqual({
            value: 100_000_000_000n,
            label: "100000",
            netLabel: "99800",
        });
    });

    it("is empty for an asset with no ladder", () => {
        expect(denominationChoices(NO_LADDER, BPS)).toEqual([]);
    });

    it("moves the labels with the index while `value` stays put", () => {
        const grown = denominationChoices(
            makeAssetInfo({
                id: USDC.id,
                token: USDC.token,
                scale: USDC.scale,
                decimals: USDC.decimals,
                index: (RAY * 105n) / 100n,
            }),
            0n,
        );
        expect(grown[0]?.value).toBe(10_000_000n); // unchanged
        expect(grown[0]?.label).toBe("10.5"); // worth more
    });
});

describe("opting out of the ladder", () => {
    // `WalletConfig.denominations: false` resolves an empty ladder onto every
    // AssetInfo, which is the single switch every path downstream reads.
    const OPTED_OUT = requireTokenMeta(
        makeAssetInfo({
            id: USDC.id,
            token: USDC.token,
            scale: USDC.scale,
            symbol: USDC.symbol,
            decimals: USDC.decimals,
            denominations: false,
        }),
    );

    it("reports no ladder and never nags about being off it", () => {
        const p = previewWithdraw({ amount: "1337", asset: OPTED_OUT, feeBps: BPS });
        expect(p.hasLadder).toBe(false);
        expect(p.onLadder).toBe(false);
        expect(p.suggestion).toBeUndefined();
        expect(p.denominations).toEqual([]);
    });

    it("still reports the gross/net split, which is unrelated to the ladder", () => {
        // Opting out is about which amounts to prefer, not about hiding what a
        // withdrawal costs.
        const p = previewWithdraw({ amount: "1000", asset: OPTED_OUT, feeBps: BPS });
        expect(p.publicOut).toBe(1_000_000_000n);
        expect(p.net).toBe(998_000_000n);
        expect(p.netFormatted).toBe("998");
    });

    it("offers no denomination choices to pick from", () => {
        expect(denominationChoices(OPTED_OUT, BPS)).toEqual([]);
    });
});
