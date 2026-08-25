// The relayer's fee, as an output note.
//
// A relayer that charges for relaying has to be paid, and paying it on chain
// would undo the spend it is relaying: an ERC-20 transfer to the relayer ties
// the payer to the transaction. So the fee is paid the same way anything else
// in the pool is — an output note addressed to the relayer's own shielded
// address, riding in the spend it pays for.
//
// The relayer holds only the incoming viewing key for that address. It can
// recognise the note and read its value; it cannot spend it, and it learns
// nothing about the other outputs.
//
// Three constraints are worth knowing before calling this:
//
//   * **A fee consumes an output slot.** Arity is fixed by the circuit
//     (`nOut`), so the fee replaces a change slot rather than extending the
//     transaction. A transfer that used `[recipient, change, change]` becomes
//     `[recipient, change, fee]`.
//   * **The fee comes out of change, not out of nowhere.** `buildSpend`
//     enforces `sumIn === publicOut + sumOut`, and the fee note is part of
//     `sumOut`. Splicing one in without taking its value off the change
//     fails that check — which is the good outcome; the bad one is taking it
//     off the *recipient's* note and quietly short-paying them. So:
//
//         const changeValue = selection.sum - sendValue - feeValue;
//         const change = splitChange(pk, asset, changeValue, nOut - 2);
//         const outputs          = [sendNote, ...change, fee.note];
//         const outputRecipients = [to, ...change.map(() => own), fee.recipient];
//         const outputRandomness = [...perOutput, fee.randomness];
//
//     Those three arrays are positional and `buildSpend` only checks their
//     lengths match, so the fee's entry has to land last in all three.
//   * **One asset per spend.** `buildSpend` requires every slot to share an
//     asset, so the fee is paid in whatever is being moved. A relayer that
//     does not accept that asset cannot relay the spend at all — which is why
//     `/chains` publishes the accepted list.

import type { Jubjub } from "../crypto/jubjub.js";
import type { Field } from "../crypto/poseidon.js";
import { decodeAddress } from "../keys/address.js";
import type { Note } from "../notes/note.js";
import { freshNoteRandomness, freshOutputAuxRandomness } from "../notes/randomness.js";
import type { EstimateResponse } from "../protocol/responses.js";
import type { OutputRandomness, OutputRecipient } from "./common.js";

/** @internal */
export interface FeeOutputArgs {
    J: Jubjub;
    /** The relayer's bech32m address, from `/chains` or `/v1/spend/estimate`. */
    relayerAddress: string;
    /** MASP asset id. Must be the asset the rest of the spend is in. */
    asset: Field;
    /**
     * Note value in **circuit** units — `FeeQuote.circuitAmount`, which the
     * relayer has already rounded up from its base-unit quote.
     */
    circuitAmount: Field;
}

/**
 * One output slot's worth of fee: the note, its recipient, and its randomness,
 * in the three parallel arrays `buildSpend` takes.
 *
 * @internal
 */
export interface FeeOutput {
    note: Note;
    recipient: OutputRecipient;
    randomness: OutputRandomness;
}

/**
 * Build the fee slot for a spend, from an address and an amount.
 *
 * {@link feeOutputFromEstimate} is usually what you want: it reads both off a
 * relayer's estimate rather than making a caller pick the right quote out of
 * `fees[]` by hand. Reach for this one when the amount comes from somewhere
 * else — a cached quote, a test, a relayer spoken to over another transport.
 *
 * `rho` is set here only to satisfy the `Note` shape — `buildSpend` overwrites
 * every output's `rho` with `Poseidon(TAG_RHO, nf0, index)`, which is what
 * binds the note to this particular spend and stops a fee note being replayed
 * into another one.
 *
 * Throws on a zero value: a zero-value output is treated as a self-pad and
 * discarded by every scanner, so it would pay nothing while looking like it
 * had.
 */
export function feeOutput({ J, relayerAddress, asset, circuitAmount }: FeeOutputArgs): FeeOutput {
    if (circuitAmount <= 0n) {
        throw new RangeError(
            `feeOutput: value must be positive, got ${circuitAmount}; a zero-value output is a ` +
                "pad and is discarded rather than delivered",
        );
    }
    const relayer = decodeAddress(J, relayerAddress);
    return {
        note: {
            asset,
            value: circuitAmount,
            pk: relayer.pk,
            ...freshNoteRandomness(),
        },
        recipient: relayer,
        randomness: freshOutputAuxRandomness(),
    };
}

/** @internal */
export interface FeeOutputFromEstimateArgs {
    J: Jubjub;
    /** The response from `RelayerClient.estimateSpend` / `estimateSwap`. */
    estimate: EstimateResponse;
    /** MASP asset id of the spend. The fee is paid in the same asset. */
    asset: Field;
}

/**
 * The fee slot for a spend, read straight off a relayer's estimate.
 *
 * Prefer this to {@link feeOutput}: an estimate carries the address on one
 * field and the amount on another, and picking the right quote out of `fees[]`
 * means matching on `assetId` — three joins a caller would otherwise redo, and
 * get subtly wrong, at every call site.
 *
 * Returns `null` when the relayer is not charging on this chain
 * (`shieldedFeeAddress` absent), which is the case where a spend needs no fee
 * slot at all. Throws when it *is* charging but cannot take this asset — that
 * is a spend which cannot be relayed, and silently omitting the fee would turn
 * it into a 402 from the submit call instead.
 */
export function feeOutputFromEstimate({
    J,
    estimate,
    asset,
}: FeeOutputFromEstimateArgs): FeeOutput | null {
    const relayerAddress = estimate.shieldedFeeAddress;
    if (relayerAddress === undefined) return null;

    // Compared as `bigint`, not by narrowing `asset` to `number`: an asset id
    // is a `u64` in circuit, and `Number()` would silently round one past 2^53.
    const quote = estimate.fees.find((f) => f.assetId !== undefined && BigInt(f.assetId) === asset);
    if (quote?.circuitAmount === undefined) {
        const offered = estimate.fees
            .map((f) => (f.assetId === undefined ? `${f.tokenSymbol}(unregistered)` : f.assetId))
            .join(", ");
        throw new Error(
            `feeOutputFromEstimate: the relayer charges a shielded fee but quoted no payable ` +
                `amount for asset ${asset}, so this spend cannot be relayed. It quoted: ` +
                `${offered || "nothing"}`,
        );
    }
    return feeOutput({ J, relayerAddress, asset, circuitAmount: BigInt(quote.circuitAmount) });
}
