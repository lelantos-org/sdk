import { describe, expect, it } from "vitest";
import { buildDeposit } from "../../bundle/deposit.js";
import { assetId, circuitAmount } from "../../core/brand.js";
import { randomBytes } from "../../core/random.js";
import { Jubjub } from "../../crypto/jubjub-wasm/index.js";
import { Poseidon } from "../../crypto/poseidon.js";
import { decodeAddress } from "../../keys/address.js";
import { ownsAddress } from "../../keys/diversified.js";
import { estimateOf, freshAddress } from "../../test-utils/estimate.js";
import { freshAccount } from "../../test-utils/outputs.js";
import type { WalletContext } from "../context.js";
import { depositSlots, resolveDepositFees } from "./deposit-fee.js";

const PAYER = "0x00000000000000000000000000000000000000aa";

/**
 * A wallet `me` over a relayer quoting `amounts` per asset, counting its quotes. The relayer
 * advertises `feeAddress` only when it `charges`.
 */
async function makeCtx(
    amounts: Record<string, bigint>,
    charges = true,
    cfg: Record<string, unknown> = {},
) {
    const P = await Poseidon.build();
    const J = await Jubjub.build();
    const feeAddress = await freshAddress(J);
    const me = freshAccount(P, J);
    const calls = { estimate: 0 };
    const estimate = estimateOf(charges ? feeAddress : undefined, amounts);
    const ctx = {
        J,
        address: me.address,
        cfg: {
            chainId: 31337n,
            submitter: {
                estimate: async () => {
                    calls.estimate++;
                    return estimate;
                },
            },
            ...cfg,
        },
    } as unknown as Pick<WalletContext, "J" | "cfg">;
    return { ctx, calls, P, J, me, feeAddress };
}

describe("resolveDepositFees", () => {
    // A swap escrows two deposits in different assets; one relayer quote covers both.
    it("prices several deposits from one quote, in order", async () => {
        const { ctx, calls, J, feeAddress } = await makeCtx({ "1": 3n, "2": 7n });

        const fees = await resolveDepositFees(ctx, [assetId(2n), assetId(1n)]);

        // Each note is priced under, and paid in, the asset it names.
        expect(fees.map((f) => [f.asset, f.value])).toEqual([
            [2n, 7n],
            [1n, 3n],
        ]);
        expect(calls.estimate).toBe(1);
        // A relayer that charges looks for its fee at its own address, and defers a deposit
        // whose fee leaf it cannot open.
        for (const fee of fees) expect(fee.recipient).toEqual(decodeAddress(J, feeAddress));
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

    // Sealed to the wallet's own address, the leaf would carry a clue for its detection key.
    it("seals a zero-value leaf to no one when the relayer advertises no fee address", async () => {
        const { ctx, P, J, me } = await makeCtx({}, false);

        const [fee] = await resolveDepositFees(ctx, [assetId(1n)]);

        expect(fee!.value).toBe(0n);
        expect(fee!.asset).toBe(1n);
        expect(fee!.recipient.oneTime).toBe(true);
        expect(ownsAddress(P, J, me.keys.ivk, fee!.recipient)).toBe(false);
        // As minted, the leaf names asset 0.
        const { deposit } = buildDeposit({
            P,
            J,
            chainId: 31337n,
            asset: 1n,
            payerAddress: PAYER,
            recipientAddress: PAYER,
            publicIn: 5n,
            recipient: decodeAddress(J, me.address),
            outgoingKey: randomBytes(32),
            ...depositSlots(fee!),
        });
        expect(deposit).toMatchObject({ feeIn: 0n, feeAssetId: 0n });
    });

    it("draws every unpaid fee leaf its own recipient: each deposit, each escrow of a swap", async () => {
        const { ctx } = await makeCtx({}, false);

        // One call prices one deposit, or a swap's output and refund escrows together.
        const deposits = [
            ...(await resolveDepositFees(ctx, [assetId(1n)])),
            ...(await resolveDepositFees(ctx, [assetId(1n)])),
        ];
        const escrows = await resolveDepositFees(ctx, [assetId(2n), assetId(1n)]);

        const recipients = [...deposits, ...escrows].map((fee) => fee.recipient);
        expect(recipients).toHaveLength(4);
        for (const part of ["d", "pk", "pk_d", "ck_d"] as const) {
            expect(new Set(recipients.map((r) => String(r[part]))).size).toBe(4);
        }
    });

    // The rule is the missing fee address, not the amount: a relayer that charges opens the fee
    // leaf before it reads the value.
    it("refuses a charging relayer's zero quote rather than sealing the leaf to no one", async () => {
        const { ctx } = await makeCtx({ "1": 0n });
        await expect(resolveDepositFees(ctx, [assetId(1n)])).rejects.toMatchObject({
            code: "FEE_ASSET_NOT_QUOTED",
            asset: 1n,
        });
    });

    // A deposit's fee is pulled from the payer's public balance, so it needs the same bound.
    it("refuses a quote `acceptRelayerFee` turns down", async () => {
        const { ctx } = await makeCtx({ "1": 3n, "2": 7n }, true, {
            acceptRelayerFee: (quote: { amount: bigint }) => quote.amount <= 5n,
        });

        await expect(resolveDepositFees(ctx, [assetId(1n)])).resolves.toHaveLength(1);
        await expect(resolveDepositFees(ctx, [assetId(1n), assetId(2n)])).rejects.toMatchObject({
            code: "FEE_ABOVE_LIMIT",
            source: "acceptRelayerFee",
            kind: "deposit",
            asset: 2n,
            quoted: 7n,
        });
    });
});

describe("depositSlots", () => {
    it("draws each leaf its own 32-byte rho nonce, fresh per deposit", async () => {
        const J = await Jubjub.build();
        const fee = {
            recipient: decodeAddress(J, await freshAddress(J)),
            value: circuitAmount(3n),
            asset: assetId(2n),
        };

        const a = depositSlots(fee);
        const b = depositSlots(fee);

        const nonces = [a.rhoNonce, a.fee.rhoNonce, b.rhoNonce, b.fee.rhoNonce];
        for (const nonce of nonces) expect(nonce).toHaveLength(32);
        expect(new Set(nonces.map(String)).size).toBe(4);
        // The fee leaf is the one `fee` describes, and nothing else rides along.
        expect(a.fee).toEqual({ ...fee, rhoNonce: a.fee.rhoNonce });
        expect(Object.keys(a).sort()).toEqual(["fee", "rhoNonce"]);
    });
});
