// The relayer's fee on a deposit, and the randomness of a deposit's two leaves.
//
// A deposit has no proof or nullifier, so its fee cannot be recognised the way
// `bundle/fee.ts` recognises a spend's fee slot. Instead the depositor mints a
// second leaf addressed to the relayer's shielded address, which the relayer
// finds by trial decryption of the `DepositEscrowed` payload.
//
// The pool cannot compute Poseidon and has no oracle, so it accepts any note.
// The relayer enforces the fee by declining to flush a deposit whose note does
// not pay it, so an under-quoted fee strands the payer's escrow until the
// cancel delay expires. The wallet must compute this amount correctly.

import type { OutputRecipient } from "../../bundle/common.js";
import type { DepositArgs } from "../../bundle/deposit.js";
import { quotedFeeAmount } from "../../bundle/fee.js";
import type { AssetId } from "../../core/brand.js";
import { branded, type CircuitAmount } from "../../core/brand.js";
import { decodeAddress } from "../../keys/address.js";
import { freshOutput } from "../../notes/randomness.js";
import { applyFee, unitFee } from "../../protocol/fees.js";
import { chargedMoney, publicMoney, shieldedMoney } from "../assets/amount.js";
import type { AssetInfo } from "../assets/info.js";
import type { WalletContext } from "../context.js";
import { relayerEstimate } from "../relayer-info.js";
import type { Money } from "../types/results.js";

/** What the relayer must be paid, in which asset, and the address to pay it at. */
export interface DepositFee {
    recipient: OutputRecipient;
    /** Circuit units of {@link DepositFee.asset}. Zero on a subsidised chain. */
    value: CircuitAmount;
    /**
     * The asset the note is paid in: the deposit's own, or the `feeAsset` it names. The relayer's
     * quote is looked up under this id.
     */
    asset: AssetId;
}

/**
 * Price the relayer notes of several deposits, in order, each paid in the asset `assets` names,
 * from one relayer quote. The quote is asset-independent; only the entry picked from it is not.
 *
 * The contract mints two leaves unconditionally, so a chain that charges nothing still gets a fee
 * note: zero-value and addressed to the depositor, where scanners discard it as an ordinary
 * self-pad.
 */
export async function resolveDepositFees(
    ctx: Pick<WalletContext, "J" | "cfg" | "address">,
    assets: readonly AssetId[],
): Promise<DepositFee[]> {
    const estimate = await relayerEstimate(ctx, "deposit");
    const feeAddress = estimate?.shieldedFeeAddress;
    if (estimate === undefined || feeAddress === undefined) {
        return assets.map((asset) => ({
            recipient: decodeAddress(ctx.J, ctx.address),
            value: branded<CircuitAmount>(0n),
            asset,
        }));
    }

    // The note is minted in the fee asset. If the relayer did not quote that
    // asset, the deposit would never be flushed and the escrow would be
    // stranded, so it is refused before anything is signed.
    return assets.map((asset) => ({
        recipient: decodeAddress(ctx.J, feeAddress),
        value: branded<CircuitAmount>(quotedFeeAmount(estimate, asset, "deposit")),
        asset,
    }));
}

/**
 * The protocol fee a deposit of `amount` pays on top of it: on base units for a plain asset, in
 * units rounded up for a yield asset, as `depositTotals` charges it. `null` when none.
 */
export function depositProtocolFee(asset: AssetInfo, amount: bigint): Money | null {
    return asset.yieldEnabled
        ? chargedMoney(shieldedMoney(asset, unitFee(amount, asset.depositBps)))
        : chargedMoney(publicMoney(asset, applyFee(amount * asset.scale, asset.depositBps)));
}

/**
 * Fresh randomness for a deposit's two leaves, with the relayer's note filled in from `fee`.
 *
 * A deposit mints the depositor's note and the relayer's fee note. Each needs
 * its own blinders; shared ones would let anyone who can open one leaf open the
 * other.
 */
export function depositSlots(fee: DepositFee): Pick<DepositArgs, "output0" | "fee"> {
    return {
        output0: freshOutput(),
        fee: { ...freshOutput(), recipient: fee.recipient, value: fee.value, asset: fee.asset },
    };
}
