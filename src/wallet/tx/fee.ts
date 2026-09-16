// Resolving the relayer's shielded fee for a spend.
//
// The relayer is paid with an output note addressed to its own shielded
// address, inside the spend it pays for (see `bundle/fee.ts` for why it is not
// an on-chain transfer). This module is the wallet side: fetch the quote, pick
// the paying asset, and return the slot.
//
// # Paying in an asset other than the one being moved
//
// The circuit conserves value per asset, not in aggregate
// (`PerAssetValueBalance` in `circuits/src/lib/balance.circom`), so one proof
// may carry the moved asset alongside a second asset that pays the fee. The
// relayer prices every asset it accepts and refuses only a fee split across
// assets.
//
// A cross-asset fee needs an input note of the fee asset and an output slot for
// its change, on top of the fee note: two slots more than a same-asset fee. At
// the 4x4 shape a transfer fits exactly: `[recipient, change, fee, fee-change]`.

import type { FeeOutput } from "../../bundle/fee.js";
import { feeOutputFromEstimate } from "../../bundle/fee.js";
import type { AssetId, CircuitAmount } from "../../core/brand.js";
import { assetId, branded } from "../../core/brand.js";
import { InvalidArgumentError } from "../../errors/config.js";
import type { DecodedAddress } from "../../keys/address.js";
import type { EstimateKind } from "../../services/relayer/submitter.js";
import { chargedMoney, shieldedMoney } from "../assets/amount.js";
import type { AssetRef } from "../assets/asset-ref.js";
import type { AssetInfo } from "../assets/info.js";
import type { WalletContext } from "../context.js";
import { relayerEstimate } from "../relayer-info.js";
import type { FeeKind } from "../types/quotes.js";
import type { Money } from "../types/results.js";
import { changeSlots, type OutputSlotSpec } from "./outputs.js";

/** The fee slot for one spend, plus what it costs and in which asset. */
export interface ResolvedFee {
    output: FeeOutput;
    asset: AssetId;
    value: CircuitAmount;
    /** True when the fee is paid in an asset the spend is not otherwise moving. */
    crossAsset: boolean;
    /**
     * Cover this fee needs separately, or `undefined` for a same-asset fee,
     * which is part of the spend's target.
     */
    cover?: { asset: AssetId; value: CircuitAmount } | undefined;
    /**
     * Output slots this fee occupies: the note itself, plus one for its change
     * when it is paid in an asset the spend has no other change slot for.
     */
    slots: number;
}

interface ResolveFeeArgs {
    kind: EstimateKind;
    /** The asset the spend is moving. */
    spendAsset: AssetId;
    /** Asset to pay the fee in. Defaults to `spendAsset`. */
    feeAsset?: AssetId | undefined;
}

/**
 * What this relay costs, as an output slot ready to splice into the spend.
 *
 * `null` means no fee slot is needed: the submitter cannot quote (a custom
 * submitter without shielded-fee support) or the relayer subsidises gas on this
 * chain.
 *
 * Throws when the relayer charges but does not accept the requested asset. The
 * relayer would reject such a spend with a 402 after a full Groth16 run, so it
 * fails here before any artifact is fetched.
 */
export async function resolveFee(
    ctx: Pick<WalletContext, "J" | "cfg">,
    args: ResolveFeeArgs,
): Promise<ResolvedFee | null> {
    const estimate = await relayerEstimate(ctx, args.kind);
    if (!estimate) return null;

    const asset = args.feeAsset ?? args.spendAsset;
    const output = feeOutputFromEstimate({ J: ctx.J, estimate, asset, kind: args.kind });
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
 * The fee asset a spend names (default: the spend's own) and the relayer's fee in it.
 *
 * The fee asset is verified, so a symbol or address the relayer maps to another id is refused
 * rather than paid in.
 */
export async function resolveSpendFee(
    ctx: Pick<WalletContext, "J" | "cfg" | "assets">,
    kind: EstimateKind,
    asset: AssetInfo,
    feeRef: AssetRef | undefined,
): Promise<{ feeAsset: AssetInfo; fee: ResolvedFee | null }> {
    const feeAsset = feeRef === undefined ? asset : await ctx.assets.resolveVerified(feeRef);
    const fee = await resolveFee(ctx, { kind, spendAsset: asset.id, feeAsset: feeAsset.id });
    return { feeAsset, fee };
}

/** A resolved fee as the `Money` results report; `null` when none is charged. */
export function relayerMoney(feeAsset: AssetInfo, fee: ResolvedFee | null): Money | null {
    return fee ? chargedMoney(shieldedMoney(feeAsset, fee.value)) : null;
}

/**
 * The output slots a resolved fee occupies: the relayer's note, then the change
 * from the notes that funded it.
 *
 * `feeSelection` is the cover `runSpend` took for a cross-asset fee, and is
 * absent for a same-asset one, whose change is part of the spend's own.
 *
 * The fee note reuses the randomness `feeOutput` drew for it so the slot is
 * self-contained; nothing depends on it being that particular draw.
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
    return [
        relayerSlot,
        // The fee asset's change. No ladder: this asset has no `publicOut` to
        // conform to.
        ...changeSlots({
            pk,
            ownAddr,
            asset: fee.asset,
            remainder: feeSelection.sum - fee.value,
            slots: 1,
        }),
    ];
}

/** The relayer estimate for `kind`: a native withdrawal is priced on its own. */
export function estimateKindOf(kind: unknown, op: string, native?: boolean): EstimateKind {
    if (kind !== "transfer" && kind !== "withdraw" && kind !== "swap" && kind !== "deposit") {
        throw new InvalidArgumentError(
            `${op}: kind must be "transfer", "withdraw", "swap" or "deposit"`,
            { argument: "kind" },
        );
    }
    return kind === "withdraw" && native ? "withdrawNative" : (kind satisfies FeeKind);
}
