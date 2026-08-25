// The relayer's fee on a deposit.
//
// Unlike a spend, a deposit has no proof and no nullifier, so the note cannot
// be recognised the way `bundle/fee.ts` recognises a spend's fee slot. What it
// has instead is a second leaf: the depositor mints a note addressed to the
// relayer's shielded address, and the relayer finds it by trial decryption of
// the `DepositEscrowed` payload.
//
// Nothing on-chain can price this. The pool cannot compute Poseidon and has no
// oracle, so it accepts whatever note the payer attaches. The enforcement is
// that the relayer declines to flush a deposit whose note does not pay it —
// which means a wallet that under-quotes strands the payer's escrow until the
// cancel delay expires. Getting this amount right is therefore the wallet's
// job, not a best effort.

import type { OutputRecipient } from "../../bundle/common.js";
import type { AssetId } from "../../core/brand.js";
import { branded, type CircuitAmount } from "../../core/brand.js";
import { decodeAddress } from "../../keys/address.js";
import type { SpendContext } from "../context.js";

/** What the relayer must be paid, and the address to pay it at. */
export interface DepositFee {
    recipient: OutputRecipient;
    /** Circuit units, in the deposit's own asset. Zero on a subsidised chain. */
    value: CircuitAmount;
}

export interface ResolveDepositFeeArgs {
    asset: AssetId;
    /** Falls back to the depositor's own address when nothing is charged. */
    recipient: string | undefined;
}

/**
 * Price this deposit's relayer note.
 *
 * A chain that charges nothing still gets a leaf — the contract mints two
 * unconditionally, so there is one code path rather than two. In that case the
 * note is zero-value and addressed to the depositor, where it reads as an
 * ordinary self-pad that every scanner discards.
 */
export async function resolveDepositFee(
    ctx: Pick<SpendContext, "J" | "cfg" | "submitter" | "address">,
    args: ResolveDepositFeeArgs,
): Promise<DepositFee> {
    const own = () => ({
        recipient: decodeAddress(ctx.J, ctx.address),
        value: branded<CircuitAmount>(0n),
    });

    if (!ctx.submitter.estimate) return own();

    const estimate = await ctx.submitter.estimate(ctx.cfg.chainId, "deposit");
    if (estimate.shieldedFeeAddress === undefined) return own();

    // The note is minted in the deposit's asset, so the relayer has to have
    // quoted that asset. One it did not quote cannot be paid in, and a deposit
    // it will not flush strands the payer's escrow — so this refuses to build
    // rather than submitting something unflushable.
    const quote = estimate.fees.find(
        (f) => f.assetId !== undefined && BigInt(f.assetId) === args.asset,
    );
    if (quote?.circuitAmount === undefined) {
        const offered = estimate.fees
            .filter((f) => f.assetId !== undefined && f.circuitAmount !== undefined)
            .map((f) => `${f.tokenSymbol ?? "?"} (id ${f.assetId})`)
            .join(", ");
        throw new Error(
            `the relayer charges to flush deposits but quoted no amount for asset ${args.asset}, ` +
                `so a deposit in it would never be flushed and would have to be cancelled. ` +
                (offered ? `It will take: ${offered}.` : "It quoted no payable asset at all."),
        );
    }

    return {
        recipient: decodeAddress(ctx.J, estimate.shieldedFeeAddress),
        value: branded<CircuitAmount>(BigInt(quote.circuitAmount)),
    };
}
