// The relayer's fee on a deposit, and the nonces of a deposit's two leaves.
//
// A deposit has no proof or nullifier, so its fee cannot be recognised the way `bundle/fee.ts`
// recognises a spend's fee slot. The depositor mints a second leaf addressed to the relayer's
// shielded address, which the relayer finds by trial decryption of the `DepositEscrowed` payload.
//
// The pool cannot compute Poseidon and has no oracle, so it accepts any note. The relayer enforces
// the fee by declining to flush a deposit whose note does not pay it, so an under-quoted fee
// strands the payer's escrow until the cancel delay expires.

import type { OutputRecipient } from "../../bundle/common.js";
import type { DepositArgs } from "../../bundle/deposit.js";
import { quotedFeeAmount } from "../../bundle/fee.js";
import type { AssetId } from "../../core/brand.js";
import { branded, type CircuitAmount } from "../../core/brand.js";
import { randomBytes } from "../../core/random.js";
import { decodeAddress } from "../../keys/address.js";
import { applyFee, unitFee } from "../../protocol/fees.js";
import { chargedMoney, publicMoney, shieldedMoney } from "../assets/amount.js";
import type { AssetInfo } from "../assets/info.js";
import type { WalletContext } from "../context.js";
import { relayerEstimate } from "../relayer-info.js";
import type { Money } from "../types/results.js";
import { assertFeeAccepted } from "./fee.js";
import { padRecipient } from "./outputs.js";

/** What the relayer must be paid, in which asset, and the address the fee leaf is sealed to. */
export interface DepositFee {
    recipient: OutputRecipient;
    /** Circuit units of {@link DepositFee.asset}. Zero when the relayer names no fee address. */
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
 * A relayer that advertises no shielded fee address is paid nothing, and each note is then a
 * zero-value leaf to a recipient drawn for it.
 */
export async function resolveDepositFees(
    ctx: Pick<WalletContext, "J" | "cfg">,
    assets: readonly AssetId[],
): Promise<DepositFee[]> {
    const estimate = await relayerEstimate(ctx, "deposit");
    const feeAddress = estimate?.shieldedFeeAddress;
    if (estimate === undefined || feeAddress === undefined) {
        // The contract mints two leaves unconditionally, so the fee leaf exists with no one to pay.
        // It is sealed to an address no one holds: sealed to the depositor's, its clue would match
        // the depositor's detection key on a deposit whose payer is public.
        return assets.map((asset) => ({
            recipient: padRecipient(ctx.J),
            value: branded<CircuitAmount>(0n),
            asset,
        }));
    }

    // The note is minted in the fee asset. A deposit paying in an asset the relayer did not quote
    // would never be flushed, so it is refused before anything is signed.
    return assets.map((asset) => {
        const value = branded<CircuitAmount>(quotedFeeAmount(estimate, asset, "deposit"));
        assertFeeAccepted(ctx, { kind: "deposit", asset, amount: value });
        return { recipient: decodeAddress(ctx.J, feeAddress), value, asset };
    });
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

/** Byte width of a deposit leaf's `rho` nonce. */
const RHO_NONCE_BYTES = 32;

/**
 * Fresh `rho` nonces for a deposit's two leaves (the depositor's note and the relayer's fee note),
 * with the latter filled in from `fee`. Each leaf needs its own: `buildDeposit` derives a leaf's
 * `rho` from its nonce, and two notes of one owner sharing a `rho` share a nullifier.
 */
export function depositSlots(fee: DepositFee): Pick<DepositArgs, "rhoNonce" | "fee"> {
    return {
        rhoNonce: randomBytes(RHO_NONCE_BYTES),
        fee: {
            recipient: fee.recipient,
            value: fee.value,
            asset: fee.asset,
            rhoNonce: randomBytes(RHO_NONCE_BYTES),
        },
    };
}
