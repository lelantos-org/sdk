import { describe, expect, it } from "vitest";
import {
    type PaymentProof,
    type PaymentProofReader,
    verifyPaymentProof,
} from "../../bundle/payment-proof.js";
import type { PublishedNote } from "../../chain/types.js";
import { circuitAmount, type Hex32 } from "../../core/brand.js";
import { fieldToBytes32 } from "../../core/hex.js";
import { TRANSACT_4X6 } from "../../protocol/shape.js";
import type { SubmitTransactPayload } from "../../protocol/transact.js";
import { makeTestCtx } from "../../test-utils/context.js";
import { estimateOf, freshAddress } from "../../test-utils/estimate.js";
import { storedNote } from "../../test-utils/wallet.js";
import { createPaymentProof } from "./payment-proof.js";
import { executeTransfer } from "./transfer.js";

// A sender proves one payment to a third party who holds only the payee's address and reads only
// the chain. The stub chain serves what the pool would publish for the spend: its `NotePayload`
// logs.

const ASSET = 1n;
const CHAIN_ID = 31337n;
const TX = `0x${"7a".repeat(32)}` as Hex32;

/** The `NotePayload`s a submitted spend would emit, by commitment. */
function publishedBy(payload: SubmitTransactPayload): Map<string, PublishedNote> {
    return new Map(
        payload.pubInputs.outCm.map((cm, i) => {
            const hex = fieldToBytes32(cm);
            return [
                hex,
                {
                    cm: hex,
                    ephPub: payload.aux[i]!.ephPub,
                    ciphertext: payload.aux[i]!.ciphertext,
                },
            ];
        }),
    );
}

/** A reader over those logs, for the one transaction that carries them. */
function readerOver(published: Map<string, PublishedNote>, chainId = CHAIN_ID): PaymentProofReader {
    return {
        chainId: async () => chainId,
        fetchNotePayload: async (txHash, cm) =>
            txHash === TX ? (published.get(cm.toLowerCase()) ?? null) : null,
    };
}

/** A 30-unit transfer to a fresh payee, with a 7-unit relayer fee, as it would land. */
async function paid() {
    const payee = await freshAddress();
    const made = await makeTestCtx({
        notes: [storedNote("01", 100n, { asset: ASSET })],
        shape: TRANSACT_4X6,
        estimate: estimateOf(await freshAddress(), { "1": 7n }),
    });
    made.submit.impl = async () => ({ txHash: TX });
    const result = await executeTransfer(made.ctx, {
        recipient: payee,
        amount: circuitAmount(30n),
        asset: ASSET,
    });
    const published = publishedBy(made.submitted.at(-1) as SubmitTransactPayload);
    const reader = readerOver(published);
    // The wallet's own chain layer reads the same logs.
    (made.ctx.cfg as { chain: unknown }).chain = { fetchNotePayload: reader.fetchNotePayload };
    return { ...made, payee, result, published, reader };
}

describe("payment proof", () => {
    it("shows a third party the asset and value one output paid the payee", async () => {
        const { ctx, payee, result, reader } = await paid();

        const proof = await createPaymentProof(ctx, {
            txHash: result.txHash,
            commitment: result.recipientCommitment,
        });

        expect(proof).toMatchObject({
            version: 1,
            chainId: "31337",
            txHash: TX,
            commitment: result.recipientCommitment,
        });
        await expect(verifyPaymentProof({ proof, recipient: payee, reader })).resolves.toEqual({
            ok: true,
            asset: ASSET,
            value: 30n,
        });
    });

    it("survives JSON, so it can be sent as text", async () => {
        const { ctx, payee, result, reader } = await paid();
        const proof = await createPaymentProof(ctx, {
            txHash: result.txHash,
            commitment: result.recipientCommitment,
        });

        const received = JSON.parse(JSON.stringify(proof)) as PaymentProof;
        await expect(
            verifyPaymentProof({ proof: received, recipient: payee, reader }),
        ).resolves.toMatchObject({ ok: true, value: 30n });
    });

    // Nothing is stored between the spend and the proof: a wallet restored from its seed on another
    // device recomputes the same secret.
    it("is recomputed from the seed, identically each time", async () => {
        const { ctx, result } = await paid();
        const target = { txHash: result.txHash, commitment: result.recipientCommitment };

        expect(await createPaymentProof(ctx, target)).toEqual(
            await createPaymentProof(ctx, target),
        );
    });

    it("opens only for the address that was paid", async () => {
        const { ctx, result, reader } = await paid();
        const proof = await createPaymentProof(ctx, {
            txHash: result.txHash,
            commitment: result.recipientCommitment,
        });

        await expect(
            verifyPaymentProof({ proof, recipient: await freshAddress(), reader }),
        ).resolves.toEqual({ ok: false, reason: "not-for-recipient" });
    });

    it("opens only its own output: another's secret is refused", async () => {
        const { ctx, payee, result, reader } = await paid();
        const change = result.ownCommitments[0]!;
        const [mine, other] = await Promise.all([
            createPaymentProof(ctx, {
                txHash: result.txHash,
                commitment: result.recipientCommitment,
            }),
            createPaymentProof(ctx, { txHash: result.txHash, commitment: change }),
        ]);

        // The change output's proof says nothing about the payee.
        await expect(
            verifyPaymentProof({ proof: other, recipient: payee, reader }),
        ).resolves.toEqual({ ok: false, reason: "not-for-recipient" });
        // And its secret does not open the payee's output.
        await expect(
            verifyPaymentProof({ proof: { ...mine, esk: other.esk }, recipient: payee, reader }),
        ).resolves.toEqual({ ok: false, reason: "wrong-ephemeral" });
    });

    it("is refused on another chain, and for an output the pool never published", async () => {
        const { ctx, payee, result, published } = await paid();
        const proof = await createPaymentProof(ctx, {
            txHash: result.txHash,
            commitment: result.recipientCommitment,
        });

        await expect(
            verifyPaymentProof({ proof, recipient: payee, reader: readerOver(published, 1n) }),
        ).resolves.toEqual({ ok: false, reason: "wrong-chain" });
        await expect(
            verifyPaymentProof({ proof, recipient: payee, reader: readerOver(new Map()) }),
        ).resolves.toEqual({ ok: false, reason: "not-published" });
    });

    it("refuses anything that is not a version-1 proof", async () => {
        const { ctx, payee, result, reader } = await paid();
        const proof = await createPaymentProof(ctx, {
            txHash: result.txHash,
            commitment: result.recipientCommitment,
        });

        for (const bad of [
            { ...proof, version: 2 },
            { ...proof, esk: "0x00" },
            { ...proof, esk: `0x${"00".repeat(32)}` },
            { ...proof, chainId: "0x7a69" },
            null,
        ]) {
            await expect(
                verifyPaymentProof({ proof: bad as never, recipient: payee, reader }),
            ).resolves.toEqual({ ok: false, reason: "malformed" });
        }
    });

    it("cannot be produced by a wallet that did not make the output", async () => {
        const { result, reader } = await paid();
        const { ctx: stranger } = await makeTestCtx({
            chain: { fetchNotePayload: reader.fetchNotePayload },
        });

        await expect(
            createPaymentProof(stranger, {
                txHash: result.txHash,
                commitment: result.recipientCommitment,
            }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "commitment" });
    });

    it("rejects a commitment the transaction does not carry, and a chain without logs", async () => {
        const { ctx, result } = await paid();

        await expect(
            createPaymentProof(ctx, { txHash: result.txHash, commitment: `0x${"00".repeat(32)}` }),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "commitment" });

        (ctx.cfg as { chain: unknown }).chain = {};
        await expect(
            createPaymentProof(ctx, {
                txHash: result.txHash,
                commitment: result.recipientCommitment,
            }),
        ).rejects.toMatchObject({
            code: "UNSUPPORTED_OPERATION",
            missing: ["chain.fetchNotePayload"],
        });
    });
});
