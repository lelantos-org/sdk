import { beforeAll, describe, expect, it } from "vitest";
import { Jubjub, Poseidon } from "../crypto/index.js";
import { FeeAssetNotQuotedError } from "../errors/funds.js";
import { decodeAddress } from "../keys/address.js";
import { addressFromViewingKey, buildSpendingKey } from "../keys/keys.js";
import type { EstimateResponse, RelayerFeeQuote } from "../protocol/responses.js";
import { feeOutput, feeOutputFromEstimate } from "./fee.js";

describe("feeOutput", () => {
    let P: Poseidon;
    let J: Jubjub;
    let address: string;
    let relayer: ReturnType<typeof buildSpendingKey>;

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        relayer = buildSpendingKey(P, 7777n);
        address = addressFromViewingKey(P, J, relayer);
    });

    // The relayer rebuilds `cm` over the `pk` of the address it published, so a slot addressed
    // anywhere else is not a payment to it.
    it("addresses the slot to the relayer's decoded address", () => {
        const out = feeOutput({ J, relayerAddress: address, asset: 1n, circuitAmount: 250n });
        expect(out).toEqual({ asset: 1n, value: 250n, recipient: decodeAddress(J, address) });
        expect(out.recipient.oneTime).toBeUndefined();
    });

    it("addresses whichever of the relayer's addresses it was given", () => {
        const other = addressFromViewingKey(P, J, relayer, 4);
        const out = feeOutput({ J, relayerAddress: other, asset: 1n, circuitAmount: 250n });
        expect(out.recipient).toEqual(decodeAddress(J, other));
        expect(out.recipient.d).not.toBe(decodeAddress(J, address).d);
    });

    // A zero-value output is a pad that every scanner drops, so it would appear
    // paid but deliver nothing.
    it("refuses a zero or negative value", () => {
        const args = { J, relayerAddress: address, asset: 1n };
        expect(() => feeOutput({ ...args, circuitAmount: 0n })).toThrow(/must be positive/);
        expect(() => feeOutput({ ...args, circuitAmount: -1n })).toThrow(/must be positive/);
    });

    it("refuses an address that is not a shielded address", () => {
        expect(() =>
            feeOutput({ J, relayerAddress: "not-an-address", asset: 1n, circuitAmount: 1n }),
        ).toThrow();
    });

    describe("feeOutputFromEstimate", () => {
        const quote = (over: Partial<RelayerFeeQuote> = {}): RelayerFeeQuote => ({
            tokenSymbol: "USDC",
            tokenAddress: "0xdead",
            decimals: 6,
            amount: "250000000000000",
            assetId: 1,
            scale: "1000000000000",
            circuitAmount: "250",
            ...over,
        });
        const estimate = (over: Partial<EstimateResponse> = {}): EstimateResponse => ({
            gasUsed: 500_000,
            effectiveGasPriceWei: "20000000000",
            totalNativeWei: "10000000000000000",
            markupBps: 1000,
            quotedAt: 0,
            fees: [quote()],
            shieldedFeeAddress: address,
            ...over,
        });

        it("takes the address and the amount off the quote for this asset", () => {
            const out = feeOutputFromEstimate({ J, estimate: estimate(), asset: 1n });
            expect(out?.value).toBe(250n);
            expect(out?.recipient).toEqual(decodeAddress(J, address));
        });

        it("picks the quote matching the asset, not the first one", () => {
            const est = estimate({
                fees: [quote({ assetId: 9, circuitAmount: "1" }), quote({ circuitAmount: "42" })],
            });
            expect(feeOutputFromEstimate({ J, estimate: est, asset: 1n })?.value).toBe(42n);
        });

        // A relayer that charges nothing omits the fee address; this is not an
        // error.
        it("returns null when the relayer charges nothing", () => {
            const { shieldedFeeAddress: _omitted, ...noFee } = estimate();
            expect(feeOutputFromEstimate({ J, estimate: noFee, asset: 1n })).toBeNull();
        });

        // Failing here avoids spending a proof on a submit that would be
        // rejected. The error lists the assets the relayer accepts instead.
        it("names the assets it will take when this one is refused", () => {
            const est = estimate({ fees: [quote({ assetId: 9 })] });
            let err: unknown;
            try {
                feeOutputFromEstimate({ J, estimate: est, asset: 1n, kind: "transfer" });
            } catch (e) {
                err = e;
            }
            expect(err).toBeInstanceOf(FeeAssetNotQuotedError);
            expect(err).toMatchObject({
                code: "FEE_ASSET_NOT_QUOTED",
                asset: 1n,
                kind: "transfer",
                accepted: [9n],
                retryable: false,
            });
        });

        it("says the spend cannot be relayed when nothing at all is payable", () => {
            const { assetId: _a, circuitAmount: _c, ...unpayable } = quote();
            const est = estimate({ fees: [unpayable] });
            expect(() => feeOutputFromEstimate({ J, estimate: est, asset: 1n })).toThrow(
                /cannot be relayed/,
            );
        });

        // A charging relayer that rounds a sub-unit cost down quotes "0". A
        // zero-value fee note pays nothing, so it is refused like no quote at
        // all, and the zero-quoted asset is not offered as an alternative.
        it("refuses a quote of zero, and does not list it as accepted", () => {
            const est = estimate({
                fees: [quote({ circuitAmount: "0" }), quote({ assetId: 9, circuitAmount: "3" })],
            });
            let err: unknown;
            try {
                feeOutputFromEstimate({ J, estimate: est, asset: 1n, kind: "deposit" });
            } catch (e) {
                err = e;
            }
            expect(err).toBeInstanceOf(FeeAssetNotQuotedError);
            expect(err).toMatchObject({
                code: "FEE_ASSET_NOT_QUOTED",
                asset: 1n,
                kind: "deposit",
                accepted: [9n],
            });
            // The other asset is still payable.
            expect(feeOutputFromEstimate({ J, estimate: est, asset: 9n })?.value).toBe(3n);
        });

        // The relayer sends `amount` without `assetId`/`scale`/`circuitAmount`
        // when the indexer has not registered the token: priced, but not payable.
        it("throws when the asset is quoted but has no payable amount yet", () => {
            const { assetId: _a, scale: _s, circuitAmount: _c, ...unregistered } = quote();
            expect(() =>
                feeOutputFromEstimate({
                    J,
                    estimate: estimate({ fees: [unregistered] }),
                    asset: 1n,
                }),
            ).toThrow(expect.objectContaining({ code: "FEE_ASSET_NOT_QUOTED", accepted: [] }));
        });
    });
});
