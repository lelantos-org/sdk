// Resolving the relayer's shielded fee for a spend.
//
// The relayer is paid with an output note addressed to its own shielded
// address, riding in the spend it pays for (see `bundle/fee.ts` for why it is
// not an on-chain transfer). This module is the wallet-side half: ask what the
// relay costs, decide which asset pays it, and hand back the slot.
//
// # Paying in an asset other than the one being moved
//
// The circuit conserves value per asset, not in aggregate
// (`PerAssetValueBalance` in `circuits/src/lib/balance.circom`), so one proof
// may carry the asset being moved alongside a second asset that pays the fee.
// Nothing in the relayer requires the two to match either: it prices every
// asset it accepts and refuses only a fee *split* across assets.
//
// What it costs is slots. A cross-asset fee needs an input note of the fee
// asset and an output slot for its change, on top of the fee note itself — two
// slots more than paying in the asset already being moved. At the 4x4 shape a
// transfer fits exactly: `[recipient, change, fee, fee-change]`.

import type { FeeOutput } from "../../bundle/fee.js";
import { feeOutputFromEstimate } from "../../bundle/fee.js";
import type { AssetId, CircuitAmount } from "../../core/brand.js";
import { assetId, branded } from "../../core/brand.js";
import type { Jubjub } from "../../crypto/index.js";
import type { DecodedAddress } from "../../keys/address.js";
import type { SpendContext } from "../context.js";
import type { EstimateKind } from "../submitter.js";
import { changeSlots, type OutputSlotSpec } from "./outputs.js";

/** The fee slot for one spend, plus what it costs and in which asset. */
export interface ResolvedFee {
    output: FeeOutput;
    asset: AssetId;
    value: CircuitAmount;
    /** True when the fee is paid in an asset the spend is not otherwise moving. */
    crossAsset: boolean;
    /**
     * Cover this fee needs in its own right, or `undefined` when it comes out
     * of the notes the spend already selects.
     *
     * A same-asset fee is part of the spend's target; a cross-asset one has to
     * be selected for separately, because no amount of the asset being moved
     * pays it.
     */
    cover?: { asset: AssetId; value: CircuitAmount } | undefined;
    /**
     * Output slots this fee occupies: the note itself, plus one for its change
     * when it is paid in an asset the spend has no other change slot for.
     */
    slots: number;
}

export interface ResolveFeeArgs {
    kind: EstimateKind;
    /** The asset the spend is moving. */
    spendAsset: AssetId;
    /** Asset to pay the fee in. Defaults to `spendAsset`. */
    feeAsset?: AssetId | undefined;
}

/**
 * What this relay costs, as an output slot ready to splice into the spend.
 *
 * `null` means no fee slot is needed — either the submitter cannot quote (a
 * custom one predating shielded fees) or the relayer is subsidising gas on this
 * chain. Both are the behaviour that predates fees, and both are correct to
 * build a spend without a fee note.
 *
 * Throws when the relayer charges but will not take the requested asset. That
 * is a spend it would refuse with a 402 after a full Groth16 run, so it is
 * worth failing here, before any artifact is fetched.
 */
export async function resolveFee(
    ctx: Pick<SpendContext, "J" | "cfg" | "submitter">,
    args: ResolveFeeArgs,
): Promise<ResolvedFee | null> {
    if (!ctx.submitter.estimate) return null;

    const estimate = await ctx.submitter.estimate(ctx.cfg.chainId, args.kind);
    const asset = args.feeAsset ?? args.spendAsset;
    const output = feeOutputFromEstimate({ J: ctx.J as Jubjub, estimate, asset });
    if (!output) return null;

    const crossAsset = asset !== args.spendAsset;
    const value = branded<CircuitAmount>(output.note.value);
    return {
        output,
        asset: assetId(asset),
        value,
        crossAsset,
        ...(crossAsset ? { cover: { asset: assetId(asset), value } } : {}),
        slots: crossAsset ? 2 : 1,
    };
}

/**
 * The output slots a resolved fee occupies: the relayer's note, then the change
 * from the notes that funded it.
 *
 * `feeSelection` is the cover `prepareSpend` took for a cross-asset fee, and is
 * absent for a same-asset one — whose change is part of the spend's own.
 *
 * The fee note carries the randomness `feeOutput` drew for it. Nothing depends
 * on that being the same draw — the aux is built from it here, not earlier — so
 * fresh randomness would do just as well; it travels with the note only so the
 * slot arrives whole rather than half-assembled.
 */
export function feeSlots(
    fee: ResolvedFee | null,
    feeSelection: { sum: bigint } | undefined,
    pk: bigint,
    ownAddr: DecodedAddress,
): OutputSlotSpec[] {
    if (!fee) return [];
    const relayerSlot: OutputSlotSpec = {
        note: fee.output.note,
        recipient: fee.output.recipient,
        randomness: fee.output.randomness,
        own: false,
    };
    if (!feeSelection) return [relayerSlot];
    return [relayerSlot, ...changeSlots(pk, ownAddr, fee.asset, feeSelection.sum - fee.value, 1)];
}
