import { describe, expect, it } from "vitest";
import { assetId } from "../../core/brand.js";
import { Jubjub } from "../../crypto/jubjub-wasm/index.js";
import { estimateOf, freshAddress } from "../../test-utils/estimate.js";
import type { WalletContext } from "../context.js";
import { resolveDepositFees } from "./deposit-fee.js";

/** A relayer quoting `amounts` per asset at `feeAddress`, counting its quotes. */
async function makeCtx(amounts: Record<string, bigint>, charges = true) {
    const J = await Jubjub.build();
    const feeAddress = await freshAddress(J);
    const calls = { estimate: 0 };
    const estimate = estimateOf(charges ? feeAddress : undefined, amounts);
    const ctx = {
        J,
        address: await freshAddress(J),
        cfg: {
            chainId: 31337n,
            submitter: {
                estimate: async () => {
                    calls.estimate++;
                    return estimate;
                },
            },
        },
    } as unknown as Pick<WalletContext, "J" | "cfg" | "address">;
    return { ctx, calls };
}

describe("resolveDepositFees", () => {
    // A swap escrows two deposits in different assets; one relayer quote
    // covers both.
    it("prices several deposits from one quote, in order", async () => {
        const { ctx, calls } = await makeCtx({ "1": 3n, "2": 7n });

        const fees = await resolveDepositFees(ctx, [assetId(2n), assetId(1n)]);

        // Each note is priced under, and paid in, the asset it names.
        expect(fees.map((f) => [f.asset, f.value])).toEqual([
            [2n, 7n],
            [1n, 3n],
        ]);
        expect(calls.estimate).toBe(1);
    });

    it("refuses an asset the relayer did not quote", async () => {
        const { ctx } = await makeCtx({ "1": 3n });
        await expect(resolveDepositFees(ctx, [assetId(2n)])).rejects.toMatchObject({
            code: "FEE_ASSET_NOT_QUOTED",
            asset: 2n,
            kind: "deposit",
            accepted: [1n],
            message: expect.stringContaining("quoted no amount for asset"),
        });
    });

    it("is a zero-value pad to the depositor when the relayer charges nothing", async () => {
        const { ctx } = await makeCtx({}, false);
        const [fee] = await resolveDepositFees(ctx, [assetId(1n)]);
        expect(fee?.value).toBe(0n);
        expect(fee?.asset).toBe(1n);
    });
});
