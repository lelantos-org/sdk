// A proof of one payment this wallet made. Backs `wallet.paymentProof`.
//
// The proof reveals the output's `rho` and output secret. The secret is recomputed from the
// wallet's outgoing key, what the output paid (recipient, asset, amount) and the nullifiers of
// its spend; `rho` from the first of those nullifiers and the output's slot. The nullifiers and
// the slot are read from the transaction's logs. See `bundle/payment-proof.ts` for what the proof
// establishes.

import { buildPaymentProof, type PaymentProof } from "../../bundle/payment-proof.js";
import { locateOutput } from "../../chain/operation.js";
import {
    type AssetIdLike,
    assetId,
    type CircuitAmountLike,
    circuitAmount,
    hex32,
} from "../../core/brand.js";
import { buildRho } from "../../crypto/index.js";
import { UnsupportedOperationError } from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import type { WalletContext } from "../context.js";
import { shieldedRecipient } from "../tx/recipient.js";

/**
 * Which output to prove, and what it paid: a transfer result's `txHash`, `recipientCommitment`,
 * `recipient` and `amount`.
 */
export interface PaymentProofTarget {
    txHash: string;
    /** The payee's commitment: `TransferResult.recipientCommitment`. */
    commitment: string;
    /** The shielded address the output paid. */
    recipient: string;
    /** The asset the output paid in. */
    asset: AssetIdLike;
    /** The output's value, in circuit units. */
    amount: CircuitAmountLike;
}

/**
 * @throws {InvalidArgumentError} for a malformed target, a commitment the pool did not publish in
 * a spend of that transaction (including a transaction the node holds no receipt for), or an
 * output this wallet's key and the stated recipient, asset and amount do not reproduce.
 * @throws {UnsupportedOperationError} when the chain layer cannot read a transaction's logs.
 */
export async function createPaymentProof(
    ctx: Pick<WalletContext, "P" | "J" | "cfg" | "outgoingKey">,
    target: PaymentProofTarget,
): Promise<PaymentProof> {
    const txHash = hex32(target.txHash);
    const commitment = hex32(target.commitment);
    const { decoded: recipient } = shieldedRecipient(ctx.J, target.recipient, "paymentProof");
    const asset = assetId(bigintArg(target.asset, "asset"));
    const value = circuitAmount(bigintArg(target.amount, "amount"));

    const { chain, chainId } = ctx.cfg;
    if (!chain.fetchNotePayload || !chain.txReceiptLogs) {
        throw new UnsupportedOperationError(
            "paymentProof",
            (["fetchNotePayload", "txReceiptLogs"] as const)
                .filter((method) => !chain[method])
                .map((method) => `chain.${method}`),
        );
    }
    const [published, pool] = await Promise.all([
        chain.fetchNotePayload(txHash, commitment),
        chain.maspAddress(),
    ]);
    // The logs are read only for a published output: `txReceiptLogs` may wait for the receipt of
    // a transaction the node does not know, and `fetchNotePayload` answers `null` for one at once.
    //
    // The slot is counted within the output's own operation: a relayer may bundle several spends
    // into one transaction.
    const located = published
        ? locateOutput(await chain.txReceiptLogs(txHash), pool, commitment)
        : undefined;
    if (!published || !located) {
        throw new InvalidArgumentError(
            "paymentProof: the pool published no such commitment in that transaction",
            { argument: "commitment" },
        );
    }
    const nullifiers = located.nullifiers.map((nullifier) => BigInt(nullifier));
    return buildPaymentProof({
        P: ctx.P,
        J: ctx.J,
        outgoingKey: ctx.outgoingKey,
        chainId,
        txHash,
        published,
        output: {
            rho: buildRho(ctx.P, nullifiers[0] as bigint, located.index),
            asset,
            value,
            recipient,
            nullifiers,
        },
    });
}

function bigintArg(value: unknown, argument: string): bigint {
    if (typeof value !== "bigint") {
        throw new InvalidArgumentError(`paymentProof: ${argument} must be a bigint`, { argument });
    }
    return value;
}
