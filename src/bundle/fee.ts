// The relayer's fee, as an output note.
//
// Paying a relayer on chain would undo the spend it relays: an ERC-20 transfer
// ties the payer to the transaction. The fee is instead an output note
// addressed to the relayer's shielded address, riding in the spend it pays for.
// The relayer holds only the incoming viewing key for that address: it can
// recognise the note and read its value, but cannot spend it and learns
// nothing about the other outputs.
//
// Three constraints apply:
//
//   * **A fee consumes an output slot.** Arity is fixed by the circuit
//     (`nOut`), so the fee replaces a change slot rather than extending the
//     transaction.
//   * **The fee comes out of change.** `buildSpend` enforces
//     `sumIn === publicOut + sumOut` and the fee note is part of `sumOut`.
//     Splicing one in without deducting its value from change fails that
//     check; deducting it from the *recipient's* note passes the check and
//     silently short-pays them. So:
//
//         const changeValue = selection.sum - sendValue - feeValue;
//         const change = splitChange(pk, asset, changeValue, nOut - 2);
//
//     The three arrays are positional and `buildSpend` checks only that their
//     lengths match, so the fee's entry must land at the same index in all
//     three. The wallet paths describe each slot as a single `OutputSlotSpec`
//     (`wallet/tx/outputs.ts`) and unzip at the `buildSpend` boundary so that
//     index cannot drift.
//
//     The fee must not go last. Slot order is the only remaining distinguisher
//     between outputs — every other per-slot public signal is a commitment or
//     a blinded point — so the wallet shuffles slots, and a fee at a fixed
//     index would publish which commitment is the relayer's on every spend. A
//     caller driving `buildSpend` by hand should shuffle too; the relayer
//     trial-decrypts every output slot to find its payment.
//   * **The fee's asset need not be the spend's.** The circuit conserves value
//     per asset rather than in aggregate (`PerAssetValueBalance`), so one proof
//     may carry the asset being moved alongside a second asset paying the
//     relayer. That costs two extra slots — an input note of the fee asset and
//     an output for its change — so the shape must be wide enough. The relayer
//     must also accept the asset: `/chains` publishes the list, and
//     `feeOutputFromEstimate` throws on one it did not quote.

import { InvalidArgumentError } from "../core/errors.js";
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
    /**
     * MASP asset id of the fee note. Need not be the asset the rest of the
     * spend is moving — see the note on asset choice at the top of this file.
     */
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
    /** MASP asset id to pay the fee in. The relayer must have quoted it. */
    asset: Field;
}

/**
 * Why this asset cannot pay, and what could.
 *
 * Names the payable assets rather than the raw quote list: the caller's next
 * move is to pick a different `feeAsset`, and an asset the relayer quoted
 * without a `circuitAmount` is not one of them.
 */
function unpayable(estimate: EstimateResponse, asset: Field): string {
    const payable = estimate.fees
        .filter((f) => f.assetId !== undefined && f.circuitAmount !== undefined)
        .map((f) => `${f.tokenSymbol ?? "?"} (id ${f.assetId})`);
    const unresolved = estimate.fees
        .filter((f) => f.assetId === undefined)
        .map((f) => f.tokenSymbol ?? "?");

    const tail = payable.length
        ? `It will take: ${payable.join(", ")}.`
        : "It quoted no payable asset at all, so this spend cannot be relayed.";
    const note = unresolved.length
        ? ` (${unresolved.join(", ")} are unregistered on this chain and cannot be paid in.)`
        : "";
    return (
        `the relayer charges a shielded fee but quoted no payable amount for asset ${asset}. ` +
        `${tail}${note}`
    );
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
        // Typed: the caller's move is to name a different `feeAsset`, and
        // `unpayable` already lists the ones that would work.
        throw new InvalidArgumentError(unpayable(estimate, asset), { argument: "feeAsset" });
    }
    return feeOutput({ J, relayerAddress, asset, circuitAmount: BigInt(quote.circuitAmount) });
}
