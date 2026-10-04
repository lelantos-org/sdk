// Payment proofs: showing a third party what one output of a spend paid.
//
// The pool publishes every output as a commitment, an ephemeral public key and a ciphertext,
// none of which says who was paid or how much. Revealing the output's ECDH ephemeral secret
// `esk` lets anyone holding the payee's address check, against the chain alone, that
//
//   1. `esk · B` is the `ephPub` the pool published for that commitment, so the secret is that
//      output's and no other's;
//   2. the ciphertext opens under `esk · pk_d`, so it was encrypted to that address;
//   3. the note it opens to, owned by that address's `pk`, hashes to the commitment, so the
//      asset and value are the ones the pool inserted.
//
// A proof opens exactly one output. It shows nothing about the spend's other outputs, its
// inputs, or any other payment to or from either party, and it grants no ability to spend the
// note or to track its later spend. The recipient cannot forge one: it knows the shared secret
// but not `esk`.
//
// `esk` is recomputed from the seed (`notes/outgoing.ts`), so a proof needs only the
// transaction hash and the commitment.

import type { PublishedNote } from "../chain/types.js";
import {
    type AssetId,
    assetId,
    branded,
    type CircuitAmount,
    type Hex32,
    isHex32,
} from "../core/brand.js";
import { BABYJUB_SUBGROUP_ORDER } from "../core/field.js";
import { fieldToBytes32 } from "../core/hex.js";
import { buildNoteCommitment } from "../crypto/commit.js";
import { cryptoContext } from "../crypto/context.js";
import type { Jubjub } from "../crypto/jubjub.js";
import { InvalidArgumentError } from "../errors/config.js";
import { decodeAddress } from "../keys/address.js";
import { decodeNotePayload, stripClueBitsPrefix } from "../notes/codec.js";
import { openNoteAsSender } from "../notes/encrypt.js";
import { deriveOutputEsk } from "../notes/outgoing.js";

/** Format version of a {@link PaymentProof}. */
export const PAYMENT_PROOF_VERSION = 1;

/**
 * A sender's proof of one payment. Every field is a string or a small integer, so it survives
 * `JSON.stringify` unchanged.
 *
 * Hand it only to whoever should learn the payment: with the payee's address it reveals that
 * output's asset and value.
 */
export interface PaymentProof {
    version: typeof PAYMENT_PROOF_VERSION;
    /** Decimal chain id of the pool the payment was made on. */
    chainId: string;
    /** The spend's transaction. */
    txHash: Hex32;
    /** The output's commitment, as the pool published it. */
    commitment: Hex32;
    /** The output's ECDH ephemeral secret. */
    esk: Hex32;
}

/** Why a payment proof does not hold. */
export type PaymentProofFailure =
    /** Malformed, or a version this SDK does not know. */
    | "malformed"
    /** Made for another chain than the one being read. */
    | "wrong-chain"
    /** The pool published no such commitment in that transaction. */
    | "not-published"
    /** `esk` is not the secret behind the output's published ephemeral key. */
    | "wrong-ephemeral"
    /** The output was not encrypted to this address. */
    | "not-for-recipient"
    /** It opens, but not to the note the pool committed to. */
    | "commitment-mismatch";

/** What a payment proof establishes, or why it establishes nothing. */
export type PaymentProofResult =
    | { ok: true; asset: AssetId; value: CircuitAmount }
    | { ok: false; reason: PaymentProofFailure };

/**
 * The proof for `published`, an output of one of this account's spends.
 *
 * @throws {InvalidArgumentError} when the account's key does not reproduce the output's
 * published ephemeral: another wallet made it, or it was built with a randomly drawn `esk`.
 *
 * @internal
 */
export function buildPaymentProof(args: {
    J: Jubjub;
    /** The account's outgoing cipher key (`deriveOutgoingKey`). */
    outgoingKey: Uint8Array;
    chainId: bigint;
    txHash: Hex32;
    published: PublishedNote;
}): PaymentProof {
    const { J, outgoingKey, chainId, txHash, published } = args;
    const esk = deriveOutputEsk(outgoingKey, chainId, BigInt(published.cm));
    if (!isEphemeralOf(J, esk, published)) {
        throw new InvalidArgumentError(
            "paymentProof: this wallet's key does not reproduce that output's ephemeral key; " +
                "another wallet created it, or this one did with an SDK that drew it at random",
            { argument: "commitment" },
        );
    }
    return Object.freeze({
        version: PAYMENT_PROOF_VERSION,
        chainId: chainId.toString(),
        txHash,
        commitment: published.cm,
        esk: fieldToBytes32(esk),
    });
}

/** The chain reads of {@link verifyPaymentProof}; a `ChainReader` with log access satisfies it. */
export interface PaymentProofReader {
    chainId(): Promise<bigint>;
    fetchNotePayload?(txHash: Hex32, cm: Hex32): Promise<PublishedNote | null>;
}

/**
 * Verify a sender's {@link PaymentProof} for a payment to `recipient`, against the chain
 * `reader` reads.
 *
 * Resolves the asset and value paid when the proof holds, and the reason when it does not.
 * Needs no key: only the payee's address, which the party asking for proof already has.
 *
 * ```ts
 * const result = await verifyPaymentProof({ proof, recipient: payeeAddress, reader });
 * if (result.ok) console.log(result.asset, result.value);
 * ```
 *
 * @throws {InvalidArgumentError} for a malformed `recipient`, or a `reader` that cannot read
 * `NotePayload` logs.
 */
export async function verifyPaymentProof(args: {
    proof: PaymentProof;
    /** The payee's shielded address. */
    recipient: string;
    reader: PaymentProofReader;
}): Promise<PaymentProofResult> {
    const { reader } = args;
    const { P, J } = await cryptoContext();
    // Decoded first, so a bad address is the caller's error rather than a verdict on the proof.
    const recipient = decodeAddress(J, args.recipient);
    if (!reader.fetchNotePayload) {
        throw new InvalidArgumentError(
            "verifyPaymentProof: the reader cannot read NotePayload logs (`fetchNotePayload`)",
            { argument: "reader" },
        );
    }
    const proof = parseProof(args.proof);
    if (!proof) return { ok: false, reason: "malformed" };
    if ((await reader.chainId()) !== proof.chainId) return { ok: false, reason: "wrong-chain" };

    // The pool's own log for that commitment in that transaction.
    const published = await reader.fetchNotePayload(proof.txHash, proof.commitment);
    if (!published) return { ok: false, reason: "not-published" };
    if (!isEphemeralOf(J, proof.esk, published)) return { ok: false, reason: "wrong-ephemeral" };

    const plaintext = openNoteAsSender({
        J,
        recipientPkD: recipient.pk_d,
        esk: proof.esk,
        note: {
            epk: J.packPoint(published.ephPub),
            ciphertext: stripClueBitsPrefix(published.ciphertext).body,
        },
    });
    if (!plaintext) return { ok: false, reason: "not-for-recipient" };

    const note = decodeNotePayload(plaintext);
    const cm = buildNoteCommitment(P, { ...note, pk: recipient.pk });
    if (cm !== BigInt(published.cm)) return { ok: false, reason: "commitment-mismatch" };

    return { ok: true, asset: assetId(note.asset), value: branded<CircuitAmount>(note.value) };
}

/** `proof`'s fields, typed, or `undefined` for anything that is not a version-1 proof. */
function parseProof(
    proof: PaymentProof,
): { chainId: bigint; txHash: Hex32; commitment: Hex32; esk: bigint } | undefined {
    const p = proof as Partial<Record<keyof PaymentProof, unknown>> | null;
    if (typeof p !== "object" || p === null || p.version !== PAYMENT_PROOF_VERSION) {
        return undefined;
    }
    const { chainId, txHash, commitment, esk } = p;
    if (typeof chainId !== "string" || !/^\d{1,78}$/.test(chainId)) return undefined;
    if (!isHex32(txHash) || !isHex32(commitment) || !isHex32(esk)) return undefined;
    const secret = BigInt(esk);
    if (secret === 0n || secret >= BABYJUB_SUBGROUP_ORDER) return undefined;
    return { chainId: BigInt(chainId), txHash, commitment, esk: secret };
}

/** Whether `esk · B` is the ephemeral public key the pool published with the output. */
function isEphemeralOf(J: Jubjub, esk: bigint, published: PublishedNote): boolean {
    const [x, y] = J.mulPointEscalar(J.base8, esk);
    return x === published.ephPub[0] && y === published.ephPub[1];
}
