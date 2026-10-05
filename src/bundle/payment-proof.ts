// Payment proofs: showing a third party what one output of a spend paid.
//
// The pool publishes every output as a commitment, a clue, an ephemeral public key and a
// ciphertext, none of which says who was paid or how much. A proof reveals the output's `rho` and
// its output secret `osk`. From them anyone derives the output's seed, and from the seed its
// commitment blinder `rcm`, ECDH ephemeral secret `esk` and clue blinder `fmdR` (`notes/seed.ts`).
// Holding the payee's address `(d, pk_d, pk, ck_d)`, with `g_d = diversifiedBase(d)`, a verifier
// checks against the chain alone that
//
//   1. `esk · g_d` is the `ephPub` the pool published for that commitment, so the secret is that
//      output's and the output was made on this address's base;
//   2. the ciphertext opens under `esk · pk_d` to a plaintext naming `d`, so it was encrypted to
//      that address;
//   3. the plaintext carries the seed and `rho` the proof derives, and the note it describes,
//      owned by that address's `pk`, hashes to the commitment, so the asset and value are the
//      ones the pool inserted, and both are non-zero, so the payee's wallet keeps the note;
//   4. the published clue is the one `fmdR` gives for `ck_d` on `g_d`, so the payee's detection
//      key flags the output.
//
// A proof opens exactly one output. It shows nothing about the spend's other outputs, its
// inputs, or any other payment to or from either party, and it grants no ability to spend the
// note or to track its later spend. The recipient cannot forge one: it learns the seed from the
// plaintext, but `osk` is a preimage of the seed.
//
// `osk` is recomputed from the sender's outgoing key, the output's `rho`, asset, value and
// recipient, and the nullifiers of its spend, so making a proof needs those and what the pool
// published.

import type { PublishedNote } from "../chain/types.js";
import {
    type AssetId,
    assetId,
    branded,
    type CircuitAmount,
    type Hex32,
    isHex32,
} from "../core/brand.js";
import { bytesEqual } from "../core/bytes.js";
import { BN254_FR } from "../core/field.js";
import { bytesToHex, fieldToBytes32, hexToBytes } from "../core/hex.js";
import { buildNoteCommitment } from "../crypto/commit.js";
import { cryptoContext } from "../crypto/context.js";
import { diversifiedBase } from "../crypto/diversified-base.js";
import { type Jubjub, type Point, samePoint } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";
import { fmdFlagOnBase } from "../fmd/clue.js";
import { fmdDiversifiedFlagKey } from "../fmd/diversified.js";
import { type DecodedAddress, decodeAddress } from "../keys/address.js";
import {
    CLUE_BITS_PREFIX_BYTES,
    clueBitsToPrefix,
    decodeNotePayload,
    type NotePayload,
} from "../notes/codec.js";
import { openNoteAsSender } from "../notes/encrypt.js";
import { type ExpandedSeed, expandSeed, seedFromSecret } from "../notes/seed.js";
import { outputSecret } from "./common.js";

/** Format version of a {@link PaymentProof}. */
export const PAYMENT_PROOF_VERSION = 2;

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
    /** The output note's `rho`, a field element. */
    rho: Hex32;
    /** The output secret: 32 bytes, the preimage of the seed in the output's plaintext. */
    osk: Hex32;
}

/** Why a payment proof does not hold. */
export type PaymentProofFailure =
    /** Malformed, or a version this SDK does not know. */
    | "malformed"
    /** Made for another chain than the one being read. */
    | "wrong-chain"
    /**
     * The pool published no such commitment in that transaction, or the reader found no such
     * transaction.
     */
    | "not-published"
    /** `osk` and `rho` do not give the secret behind the output's published ephemeral key. */
    | "wrong-ephemeral"
    /** The output was not encrypted to this address. */
    | "not-for-recipient"
    /**
     * The output carries value 0 or names asset 0. The payee's scanner discards such a note, so
     * it credited nothing.
     */
    | "no-value"
    /** It opens, but not to the note the pool committed to. */
    | "commitment-mismatch"
    /** The published clue is not the one the output's seed gives for this address. */
    | "wrong-clue";

/** What a payment proof establishes, or why it establishes nothing. */
export type PaymentProofResult =
    | { ok: true; asset: AssetId; value: CircuitAmount }
    | { ok: false; reason: PaymentProofFailure };

/**
 * The proof for `published`, an output of one of this account's spends.
 *
 * `output` is what the wallet sealed: the note's `rho` (`Poseidon(TAG_RHO, nullifiers[0], index)`),
 * its asset and value, the address it paid, and its spend's public nullifiers in input-slot order.
 *
 * @throws {InvalidArgumentError} when the account's key and `output` do not reproduce the
 * output's published ephemeral key: another wallet made it, or it paid a different recipient,
 * asset or amount, or the nullifiers are not its spend's. Also when a field of `output` is out of
 * range.
 *
 * @internal
 */
export function buildPaymentProof(args: {
    P: Poseidon;
    J: Jubjub;
    /** The account's outgoing key (`deriveOutgoingKey`). */
    outgoingKey: Uint8Array;
    chainId: bigint;
    txHash: Hex32;
    published: PublishedNote;
    output: {
        rho: Field;
        asset: bigint;
        value: bigint;
        recipient: DecodedAddress;
        nullifiers: readonly Field[];
    };
}): PaymentProof {
    const { P, J, outgoingKey, chainId, txHash, published } = args;
    const { rho, recipient } = args.output;
    const osk = outputSecret(J, { outgoingKey, chainId, ...args.output });
    const { ephPub } = expandSecret(J, P, osk, rho, recipient.d);
    if (!samePoint(ephPub, published.ephPub)) {
        throw new InvalidArgumentError(
            "paymentProof: this wallet's key does not reproduce that output's ephemeral key; " +
                "another wallet created it, or it paid a different recipient, asset or amount",
            { argument: "commitment" },
        );
    }
    return Object.freeze({
        version: PAYMENT_PROOF_VERSION,
        chainId: chainId.toString(),
        txHash,
        commitment: published.cm,
        rho: fieldToBytes32(rho),
        osk: branded<Hex32>(bytesToHex(osk)),
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
    const fail = (reason: PaymentProofFailure): PaymentProofResult => ({ ok: false, reason });

    // The checks run in this order, and the first to fail is the reason.
    const proof = parseProof(args.proof);
    if (!proof) return fail("malformed");
    if ((await reader.chainId()) !== proof.chainId) return fail("wrong-chain");
    // The pool's own log for that commitment in that transaction.
    const published = await reader.fetchNotePayload(proof.txHash, proof.commitment);
    if (!published) return fail("not-published");

    const { rho } = proof;
    const { rseed, rcm, esk, fmdR, gD, ephPub } = expandSecret(J, P, proof.osk, rho, recipient.d);
    // Equality with a point computed here also shows the published `ephPub` is on the curve.
    if (!samePoint(ephPub, published.ephPub)) return fail("wrong-ephemeral");

    const plaintext = openPublished(J, published, recipient.pk_d, esk);
    if (!plaintext) return fail("not-for-recipient");
    const note = tryDecode(plaintext);
    // An authenticated plaintext that is not a note payload is not the committed note.
    if (!note) return fail("commitment-mismatch");
    if (note.d !== recipient.d) return fail("not-for-recipient");
    // The payee's scanner keeps neither a value-0 note nor one naming asset 0 (`sync/scan.ts`).
    if (note.value === 0n || note.asset === 0n) return fail("no-value");

    // With the seed and `rho` equal to the proof's, `rcm` is the note's blinder.
    if (!bytesEqual(note.rseed, rseed) || note.rho !== rho) return fail("commitment-mismatch");
    const { asset, value } = note;
    const cm = buildNoteCommitment(P, { asset, value, pk: recipient.pk, rho, rcm });
    if (cm !== BigInt(published.cm)) return fail("commitment-mismatch");

    if (!carriesClue(J, P, published, recipient.ck_d, gD, fmdR)) return fail("wrong-clue");

    return { ok: true, asset: assetId(asset), value: branded<CircuitAmount>(value) };
}

/**
 * What `osk` and `rho` fix of an output to the address with diversifier `d`: the seed its
 * plaintext carries, the randomness the seed expands to, the address's base `g_d`, and the
 * ephemeral key `esk · g_d` the pool published for it.
 */
function expandSecret(
    J: Jubjub,
    P: Poseidon,
    osk: Uint8Array,
    rho: Field,
    d: Field,
): ExpandedSeed & { rseed: Uint8Array; gD: Point; ephPub: Point } {
    const rseed = seedFromSecret(osk);
    const expanded = expandSeed(rseed, rho);
    const gD = diversifiedBase(J, P, d);
    return { ...expanded, rseed, gD, ephPub: J.mulPointEscalar(gD, expanded.esk) };
}

/**
 * The plaintext `published` carries for the holder of `pkD`, opened with `esk`; `null` when the
 * ciphertext has no body past its clue bits or the body does not authenticate.
 */
function openPublished(
    J: Jubjub,
    published: PublishedNote,
    pkD: Point,
    esk: Field,
): Uint8Array | null {
    const { ciphertext, ephPub } = published;
    if (ciphertext.length < CLUE_BITS_PREFIX_BYTES) return null;
    return openNoteAsSender({
        J,
        recipientPkD: pkD,
        esk,
        note: {
            epk: J.packPoint(ephPub),
            ciphertext: ciphertext.subarray(CLUE_BITS_PREFIX_BYTES),
        },
    });
}

/**
 * Whether `published` carries the clue `fmdR` gives for clue key `ckD` on `gD`: its point `R`, and
 * its bits as the ciphertext's prefix.
 */
function carriesClue(
    J: Jubjub,
    P: Poseidon,
    published: PublishedNote,
    ckD: Point,
    gD: Point,
    fmdR: Field,
): boolean {
    const clue = fmdFlagOnBase(J, P, fmdDiversifiedFlagKey(J, P, ckD, gD), gD, fmdR);
    const clueR = J.unpackPoint(clue.R);
    if (!clueR || !samePoint(clueR, published.clueR)) return false;
    return bytesEqual(
        clueBitsToPrefix(clue.bits, clue.gamma),
        published.ciphertext.subarray(0, CLUE_BITS_PREFIX_BYTES),
    );
}

/** A proof's fields, typed and range-checked. */
interface ParsedProof {
    chainId: bigint;
    txHash: Hex32;
    commitment: Hex32;
    rho: Field;
    osk: Uint8Array;
}

/**
 * `proof`'s fields, or `undefined` for anything that is not a well-formed proof of
 * {@link PAYMENT_PROOF_VERSION}: a wrong version, a missing or mistyped field, or a `rho` that is
 * not a canonical field element.
 */
function parseProof(proof: PaymentProof): ParsedProof | undefined {
    const p = proof as Partial<Record<keyof PaymentProof, unknown>> | null;
    if (typeof p !== "object" || p === null || p.version !== PAYMENT_PROOF_VERSION) {
        return undefined;
    }
    const { chainId, txHash, commitment, rho, osk } = p;
    if (typeof chainId !== "string" || !/^\d{1,78}$/.test(chainId)) return undefined;
    if (!isHex32(txHash) || !isHex32(commitment) || !isHex32(rho) || !isHex32(osk)) {
        return undefined;
    }
    const rhoField = BigInt(rho);
    if (rhoField >= BN254_FR) return undefined;
    return { chainId: BigInt(chainId), txHash, commitment, rho: rhoField, osk: hexToBytes(osk) };
}

/** The note payload `plaintext` encodes, or `undefined` when it is not one. */
function tryDecode(plaintext: Uint8Array): NotePayload | undefined {
    try {
        return decodeNotePayload(plaintext);
    } catch {
        return undefined;
    }
}
