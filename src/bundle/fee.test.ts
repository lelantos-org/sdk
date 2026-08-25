import { beforeAll, describe, expect, it } from "vitest";
import { Jubjub, Poseidon } from "../crypto/index.js";
import { encodeAddress } from "../keys/address.js";
import { buildSpendingKey } from "../keys/keys.js";
import type { EstimateResponse, FeeQuote } from "../protocol/responses.js";
import { feeOutput, feeOutputFromEstimate } from "./fee.js";

describe("feeOutput", () => {
    let P: Poseidon;
    let J: Jubjub;
    let address: string;
    let relayer: ReturnType<typeof buildSpendingKey>;

    beforeAll(async () => {
        P = await Poseidon.build();
        J = await Jubjub.build();
        relayer = buildSpendingKey(P, J, 7777n);
        address = encodeAddress(J, relayer.pk_d, relayer.pk, relayer.ck);
    });

    // The whole point: the relayer rebuilds `cm` over its own `pk`, so a note
    // built for any other `pk` is not a payment to it.
    it("binds the note to the pk the relayer will rebuild the commitment over", () => {
        const out = feeOutput({ J, relayerAddress: address, asset: 1n, circuitAmount: 250n });
        expect(out.note.pk).toBe(relayer.pk);
        expect(out.recipient.pk_d).toEqual(relayer.pk_d);
        expect(out.note.value).toBe(250n);
        expect(out.note.asset).toBe(1n);
    });

    it("draws fresh randomness per call, so two fees never share a commitment", () => {
        const a = feeOutput({ J, relayerAddress: address, asset: 1n, circuitAmount: 250n });
        const b = feeOutput({ J, relayerAddress: address, asset: 1n, circuitAmount: 250n });
        expect(a.note.rcm).not.toBe(b.note.rcm);
        expect(a.randomness.esk).not.toBe(b.randomness.esk);
    });

    // A zero-value output is a pad: every scanner drops it, so it would look
    // paid and deliver nothing.
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
        const quote = (over: Partial<FeeQuote> = {}): FeeQuote => ({
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
            expect(out?.note.value).toBe(250n);
            expect(out?.note.pk).toBe(relayer.pk);
        });

        it("picks the quote matching the asset, not the first one", () => {
            const est = estimate({
                fees: [quote({ assetId: 9, circuitAmount: "1" }), quote({ circuitAmount: "42" })],
            });
            expect(feeOutputFromEstimate({ J, estimate: est, asset: 1n })?.note.value).toBe(42n);
        });

        // No fee to build is a normal outcome, not an error: it is what every
        // relayer that charges nothing returns.
        it("returns null when the relayer charges nothing", () => {
            const { shieldedFeeAddress: _omitted, ...noFee } = estimate();
            expect(feeOutputFromEstimate({ J, estimate: noFee, asset: 1n })).toBeNull();
        });

        // Omitting the fee here would just move the failure to the submit
        // call, where it costs a proof.
        // The useful part of the failure is what to pay with instead: this
        // spend *is* relayable, just not in the asset that was asked for.
        it("names the assets it will take when this one is refused", () => {
            const est = estimate({ fees: [quote({ assetId: 9 })] });
            expect(() => feeOutputFromEstimate({ J, estimate: est, asset: 1n })).toThrow(
                /no payable amount for asset 1\..*It will take:.*id 9/s,
            );
        });

        it("says the spend cannot be relayed when nothing at all is payable", () => {
            const { assetId: _a, circuitAmount: _c, ...unpayable } = quote();
            const est = estimate({ fees: [unpayable] });
            expect(() => feeOutputFromEstimate({ J, estimate: est, asset: 1n })).toThrow(
                /cannot be relayed/,
            );
        });

        // The relayer sends `amount` without `assetId`/`scale`/`circuitAmount`
        // when the indexer has not registered the token yet: priced, but not
        // yet payable.
        it("throws when the asset is quoted but has no payable amount yet", () => {
            const { assetId: _a, scale: _s, circuitAmount: _c, ...unregistered } = quote();
            expect(() =>
                feeOutputFromEstimate({
                    J,
                    estimate: estimate({ fees: [unregistered] }),
                    asset: 1n,
                }),
            ).toThrow(/unregistered/);
        });
    });
});
