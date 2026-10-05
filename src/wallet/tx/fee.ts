// Resolving the relayer's shielded fee for a spend: fetch the quote, pick the paying asset, and
// return the slot. The relayer is paid with an output note addressed to its own shielded address,
// inside the spend it pays for (see `bundle/fee.ts`).
//
// The circuit conserves value per asset (`PerAssetValueBalance` in
// `circuits/src/lib/balance.circom`), so one proof may carry the moved asset alongside a second
// asset that pays the fee. The relayer prices every asset it accepts and refuses only a fee split
// across assets.
//
// A cross-asset fee needs an input note of the fee asset and an output slot for its change, on top
// of the fee note.

import type { FeeOutput } from "../../bundle/fee.js";
import { feeOutputFromEstimate } from "../../bundle/fee.js";
import type { AssetId, CircuitAmount } from "../../core/brand.js";
import { assetId, branded } from "../../core/brand.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { FeeAboveLimitError, type FeeQuoteKind } from "../../errors/funds.js";
import type { DecodedAddress } from "../../keys/address.js";
import type { EstimateKind } from "../../services/relayer/submitter.js";
import { type Amount, chargedMoney, resolveAmount, shieldedMoney } from "../assets/amount.js";
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
     * Cover this fee needs separately, or `undefined` for a same-asset fee, which is part of the
     * spend's target.
     */
    cover?: { asset: AssetId; value: CircuitAmount } | undefined;
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
 * `null` means no fee slot is needed: the submitter cannot quote (a custom submitter without
 * shielded-fee support) or the relayer subsidises gas on this chain.
 *
 * Throws when the relayer charges but does not accept the requested asset: the relayer would
 * reject such a spend with a 402 only after it is proven.
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
    const value = branded<CircuitAmount>(output.value);
    assertFeeAccepted(ctx, { kind: args.kind, asset: assetId(asset), amount: value });
    return {
        output,
        asset: assetId(asset),
        value,
        crossAsset,
        ...(crossAsset ? { cover: { asset: assetId(asset), value } } : {}),
    };
}

/**
 * Refuse a quote the wallet's `acceptRelayerFee` turns down.
 *
 * The quote is the relayer's own figure and the wallet pays it as stated, so this is the only bound
 * on it. Every quote about to be paid passes through here: spends and the self-spends nested in
 * them via {@link resolveFee}, deposits via `resolveDepositFees`.
 *
 * @throws {FeeAboveLimitError}
 */
export function assertFeeAccepted(
    ctx: { readonly cfg: Pick<WalletContext["cfg"], "acceptRelayerFee"> },
    quote: { kind: FeeQuoteKind; asset: AssetId; amount: CircuitAmount },
): void {
    const accept = ctx.cfg.acceptRelayerFee;
    if (accept === undefined || accept(Object.freeze({ ...quote }))) return;
    throw new FeeAboveLimitError({
        asset: quote.asset,
        quoted: quote.amount,
        source: "acceptRelayerFee",
        kind: quote.kind,
    });
}

/**
 * Refuse a fee above the operation's own `maxFee`, stated in the fee asset.
 *
 * @throws {FeeAboveLimitError}
 */
export function assertWithinMaxFee(
    maxFee: Amount | undefined,
    kind: FeeQuoteKind,
    feeAsset: AssetInfo,
    fee: ResolvedFee | null,
): void {
    if (maxFee === undefined || fee === null) return;
    const limit = resolveAmount(maxFee, feeAsset, "maxFee");
    if (fee.value <= limit) return;
    throw new FeeAboveLimitError({
        asset: fee.asset,
        quoted: fee.value,
        limit,
        source: "maxFee",
        kind,
    });
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
 * The output slots a resolved fee occupies: the relayer's note, then the change from the notes
 * that funded it, when any is left.
 *
 * `feeSelection` is the cover `runSpend` took for a cross-asset fee, and is absent for a same-asset
 * one, whose change is part of the spend's own.
 */
export function feeSlots(
    fee: ResolvedFee | null,
    feeSelection: { sum: bigint } | undefined,
    ownAddr: DecodedAddress,
): OutputSlotSpec[] {
    if (!fee) return [];
    const relayerSlot: OutputSlotSpec = { ...fee.output, own: false };
    if (!feeSelection) return [relayerSlot];
    return [
        relayerSlot,
        // The fee asset's change. No ladder: this asset has no `publicOut` to conform to.
        ...changeSlots({
            ownAddr,
            asset: fee.asset,
            remainder: feeSelection.sum - fee.value,
            maxNotes: 1,
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
