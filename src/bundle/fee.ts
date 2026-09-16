// The relayer's fee, as an output note.
//
// A public on-chain payment (e.g. an ERC-20 transfer) would link the payer to
// the relayed transaction. The fee is instead an output note addressed to the
// relayer's shielded address, carried in the spend it pays for. The relayer
// holds only the incoming viewing key for that address: it can recognise the
// note and read its value, but cannot spend it and learns nothing about the
// other outputs.
//
// Three constraints apply:
//
//   * **A fee consumes an output slot.** Arity is fixed by the circuit
//     (`nOut`), so the fee replaces a change slot rather than extending the
//     transaction.
//   * **The fee comes out of change.** `buildSpend` enforces
//     `sumIn === publicOut + sumOut` and the fee note is part of `sumOut`.
//     Adding one without deducting its value from change fails that check;
//     deducting it from the *recipient's* note passes the check and
//     short-pays the recipient. So:
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
//     The fee must not be at a fixed index. Slot order is the only remaining
//     distinguisher between outputs (every other per-slot public signal is a
//     commitment or a blinded point), so a fixed position would reveal which
//     commitment is the relayer's. The wallet shuffles slots; a caller using
//     `buildSpend` directly should shuffle too. The relayer trial-decrypts
//     every output slot to find its payment.
//   * **The fee's asset need not be the spend's.** The circuit conserves value
//     per asset rather than in aggregate (`PerAssetValueBalance`), so one proof
//     may carry the asset being moved alongside a second asset paying the
//     relayer. That costs two extra slots (an input note of the fee asset and
//     an output for its change), so the shape must be wide enough. The relayer
//     must also accept the asset: `/chains` publishes the list, and
//     `feeOutputFromEstimate` throws `FeeAssetNotQuotedError` on one it did not quote.

import { assetId } from "../core/brand.js";
import type { Jubjub } from "../crypto/jubjub.js";
import type { Field } from "../crypto/poseidon.js";
import { InvalidArgumentError } from "../errors/config.js";
import { FeeAssetNotQuotedError, type FeeQuoteKind } from "../errors/funds.js";
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
     * MASP asset id of the fee note. May differ from the asset the spend moves;
     * see the file header.
     */
    asset: Field;
    /**
     * Note value in **circuit** units: `RelayerFeeQuote.circuitAmount`, which the
     * relayer rounds up from its base-unit quote.
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
 * Prefer {@link feeOutputFromEstimate}, which reads both from a relayer's
 * estimate. Use this when the amount comes from elsewhere, such as a cached
 * quote, a test, or a relayer reached over another transport.
 *
 * `rho` is set only to satisfy the `Note` shape: `buildSpend` overwrites every
 * output's `rho` with `Poseidon(TAG_RHO, nf0, index)`, which binds the note to
 * this spend and prevents a fee note from being replayed into another.
 *
 * Throws on a zero value: a zero-value output is treated as a self-pad and
 * discarded by every scanner, so it would pay nothing.
 */
export function feeOutput({ J, relayerAddress, asset, circuitAmount }: FeeOutputArgs): FeeOutput {
    if (circuitAmount <= 0n) {
        throw new InvalidArgumentError(
            "feeOutput: value must be positive; a zero-value output is a pad and is discarded " +
                "rather than delivered",
            { argument: "circuitAmount" },
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
    /** What the estimate priced; reported on `FeeAssetNotQuotedError`. */
    kind?: FeeQuoteKind | undefined;
}

/**
 * The error for an asset the relayer quoted no payable amount for.
 *
 * Lists only payable assets in `accepted`, since the caller's remedy is a
 * different fee asset and an asset quoted without a `circuitAmount` (or with no
 * registered id) is not payable.
 *
 * @internal
 */
function feeAssetNotQuoted(
    estimate: EstimateResponse,
    asset: Field,
    kind?: FeeQuoteKind | undefined,
): FeeAssetNotQuotedError {
    const accepted = estimate.fees
        .filter((f) => f.assetId !== undefined && f.circuitAmount !== undefined)
        .map((f) => assetId(BigInt(f.assetId!)));
    return new FeeAssetNotQuotedError({ asset: assetId(asset), kind, accepted });
}

/**
 * The fee slot for a spend, read from a relayer's estimate.
 *
 * Preferred over {@link feeOutput}: it takes the address and the amount from
 * their respective fields and selects the quote from `fees[]` by `assetId`.
 *
 * Returns `null` when the relayer does not charge on this chain
 * (`shieldedFeeAddress` absent), in which case the spend needs no fee slot.
 * Throws `FeeAssetNotQuotedError` when it charges but cannot take this asset:
 * such a spend cannot be relayed, and omitting the fee would only surface as a
 * 402 from the submit call.
 */
export function feeOutputFromEstimate({
    J,
    estimate,
    asset,
    kind,
}: FeeOutputFromEstimateArgs): FeeOutput | null {
    const relayerAddress = estimate.shieldedFeeAddress;
    if (relayerAddress === undefined) return null;

    const circuitAmount = quotedFeeAmount(estimate, asset, kind);
    return feeOutput({ J, relayerAddress, asset, circuitAmount });
}

/**
 * The fee `estimate` quotes for paying in `asset`, in circuit units.
 *
 * The one lookup of an asset's entry in a relayer quote, shared by spends and
 * deposits. Throws `FeeAssetNotQuotedError` when the relayer quoted no payable
 * amount for it: a spend or deposit paying in that asset would be refused.
 *
 * @internal
 */
export function quotedFeeAmount(
    estimate: EstimateResponse,
    asset: Field,
    kind?: FeeQuoteKind | undefined,
): bigint {
    // Compared as `bigint`: an asset id is a `u64` in circuit, and `Number()`
    // rounds values past 2^53.
    const quote = estimate.fees.find((f) => f.assetId !== undefined && BigInt(f.assetId) === asset);
    if (quote?.circuitAmount === undefined) throw feeAssetNotQuoted(estimate, asset, kind);
    return BigInt(quote.circuitAmount);
}
