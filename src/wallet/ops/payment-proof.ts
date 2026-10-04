// A proof of one payment this wallet made. Backs `wallet.paymentProof`.
//
// The proof is the output's ECDH ephemeral secret, recomputed from the seed and what the pool
// published with the output; see `bundle/payment-proof.ts` for what it establishes.

import { buildPaymentProof, type PaymentProof } from "../../bundle/payment-proof.js";
import { hex32 } from "../../core/brand.js";
import { UnsupportedOperationError } from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { deriveOutgoingKey } from "../../notes/outgoing.js";
import type { WalletContext } from "../context.js";

/** Which output to prove: a spend result's `txHash` and one of its `commitments`. */
export interface PaymentProofTarget {
    txHash: string;
    /** The payee's commitment: `TransferResult.recipientCommitment`. */
    commitment: string;
}

export async function createPaymentProof(
    ctx: Pick<WalletContext, "J" | "cfg" | "keys">,
    target: PaymentProofTarget,
): Promise<PaymentProof> {
    const txHash = hex32(target.txHash);
    const commitment = hex32(target.commitment);
    const { chain, chainId } = ctx.cfg;
    if (!chain.fetchNotePayload) {
        throw new UnsupportedOperationError("paymentProof", ["chain.fetchNotePayload"]);
    }
    const published = await chain.fetchNotePayload(txHash, commitment);
    if (!published) {
        throw new InvalidArgumentError(
            "paymentProof: the pool published no such commitment in that transaction",
            { argument: "commitment" },
        );
    }
    return buildPaymentProof({
        J: ctx.J,
        outgoingKey: deriveOutgoingKey(ctx.keys.nsk),
        chainId,
        txHash,
        published,
    });
}
