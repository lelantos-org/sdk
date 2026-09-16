import { describe, expect, it } from "vitest";
import { branded, type TokenAmount } from "../core/brand.js";
import { depositFeeAssetRefusal, depositPulls } from "./deposit-pulls.js";
import { depositCeiling } from "./fees.js";

const base = (n: bigint) => branded<TokenAmount>(n);

const USDC = { id: 1n, token: "0x00000000000000000000000000000000000000A1", yieldEnabled: false };
const DAI = { id: 2n, token: "0x00000000000000000000000000000000000000d1", yieldEnabled: false };
/** A yield id over USDC's own token, spelled in another case. */
const YUSDC = { id: 3n, token: "0x00000000000000000000000000000000000000a1", yieldEnabled: true };

type Asset = typeof USDC;
const amounts = (pulls: { asset: Asset; amount: bigint | undefined }[]) =>
    pulls.map((p) => [p.asset.id, p.amount]);

describe("depositPulls", () => {
    it("rides a fee in the deposited asset in the principal's pull", () => {
        const r = depositPulls({
            deposited: USDC,
            feeAsset: USDC,
            principal: base(1_010n),
            relayer: base(7n),
        });
        expect(r.separateFee).toBeUndefined();
        expect(r.feeSharesToken).toBe(true);
        expect(amounts(r.byAsset)).toEqual([[1n, 1_017n]]);
        expect(amounts(r.byToken)).toEqual([[1n, 1_017n]]);
    });

    it("pulls a valued fee in another token on its own", () => {
        const r = depositPulls({
            deposited: USDC,
            feeAsset: DAI,
            principal: base(1_010n),
            relayer: base(42_000n),
        });
        expect(r.separateFee).toBe(DAI);
        expect(r.feeSharesToken).toBe(false);
        const both = [
            [1n, 1_010n],
            [2n, 42_000n],
        ];
        expect(amounts(r.byAsset)).toEqual(both);
        expect(amounts(r.byToken)).toEqual(both);
    });

    // The pool takes the single-token path (`isSameFeeAsset`): a zero fee is a
    // self-pad note in the deposited asset.
    it("keeps a zero fee in the principal's pull, whatever asset was picked", () => {
        const r = depositPulls({
            deposited: USDC,
            feeAsset: DAI,
            principal: base(1_010n),
            relayer: base(0n),
        });
        expect(r.separateFee).toBeUndefined();
        expect(amounts(r.byToken)).toEqual([[1n, 1_010n]]);
    });

    // Separate by asset id, summed by token: the two pulls draw on one balance
    // and one Permit2 window.
    it("sums a separate fee in another id over the deposited token, case-insensitively", () => {
        const r = depositPulls({
            deposited: YUSDC,
            feeAsset: USDC,
            principal: base(1_010n),
            relayer: base(5n),
        });
        expect(r.separateFee).toBe(USDC);
        expect(r.feeSharesToken).toBe(true);
        expect(amounts(r.byAsset)).toEqual([
            [3n, 1_010n],
            [1n, 5n],
        ]);
        expect(amounts(r.byToken)).toEqual([[3n, 1_015n]]);
    });

    it("decides by id while the fee is unknown, and never states a partial sum", () => {
        const cross = depositPulls<Asset, TokenAmount | undefined>({
            deposited: USDC,
            feeAsset: DAI,
            principal: base(1_010n),
            relayer: undefined,
        });
        expect(cross.separateFee).toBe(DAI);
        expect(amounts(cross.byToken)).toEqual([
            [1n, 1_010n],
            [2n, undefined],
        ]);

        const same = depositPulls<Asset, TokenAmount | undefined>({
            deposited: USDC,
            feeAsset: USDC,
            principal: base(1_010n),
            relayer: undefined,
        });
        expect(amounts(same.byToken)).toEqual([[1n, undefined]]);

        const shared = depositPulls<Asset, TokenAmount | undefined>({
            deposited: YUSDC,
            feeAsset: USDC,
            principal: undefined,
            relayer: base(5n),
        });
        expect(amounts(shared.byToken)).toEqual([[3n, undefined]]);
    });

    // As `Wallet.deposit` signs: headroom on the deposited asset's pull only, and
    // before a fee over the same token is added to it.
    it("sizes the deposited pull as its ceiling before summing, when asked", () => {
        const principal = base(10_050n);
        const riding = depositPulls({
            deposited: YUSDC,
            feeAsset: YUSDC,
            principal,
            relayer: base(30n),
            ceiling: true,
        });
        expect(amounts(riding.byAsset)).toEqual([[3n, depositCeiling(base(10_080n), true)]]);

        const apart = depositPulls({
            deposited: YUSDC,
            feeAsset: USDC,
            principal,
            relayer: base(30n),
            ceiling: true,
        });
        expect(amounts(apart.byAsset)).toEqual([
            [3n, depositCeiling(principal, true)],
            [1n, 30n],
        ]);
        expect(amounts(apart.byToken)).toEqual([[3n, depositCeiling(principal, true) + 30n]]);

        // A plain asset's ceiling is its quote.
        const plain = depositPulls({
            deposited: USDC,
            feeAsset: USDC,
            principal,
            relayer: base(30n),
            ceiling: true,
        });
        expect(amounts(plain.byToken)).toEqual([[1n, 10_080n]]);
    });
});

describe("depositFeeAssetRefusal", () => {
    it("takes the deposited asset, even a yield one, and even on native ETH", () => {
        expect(depositFeeAssetRefusal(YUSDC, YUSDC, false)).toBeUndefined();
        expect(depositFeeAssetRefusal(USDC, USDC, true)).toBeUndefined();
    });

    it("takes another plain asset only off the native-ETH path", () => {
        expect(depositFeeAssetRefusal(USDC, DAI, false)).toBeUndefined();
        expect(depositFeeAssetRefusal(USDC, DAI, true)).toBe("native-deposit");
    });

    it("refuses a yield asset other than the one deposited", () => {
        expect(depositFeeAssetRefusal(USDC, YUSDC, false)).toBe("yield-fee-asset");
        // The native path is named first: no other asset is taken there at all.
        expect(depositFeeAssetRefusal(USDC, YUSDC, true)).toBe("native-deposit");
    });
});
