// The deposits a wrapper (`SwapWrapper`, `GenericCallWrapper`) escrows after its withdraw leg, and
// where a cancelled one refunds to.

import { isAddressEqual, zeroAddress } from "viem";
import { type BuiltDeposit, buildDeposit } from "../../bundle/deposit.js";
import { supportsSigning } from "../../chain/port.js";
import { type AssetId, type EvmAddress, evmAddress } from "../../core/brand.js";
import { InvalidArgumentError } from "../../errors/config.js";
import type { DecodedAddress } from "../../keys/address.js";
import { abiAddress } from "../../protocol/deposit-request.js";
import { assertPublicInFits } from "../../protocol/fees.js";
import type { YieldPricing } from "../../protocol/swap-sizing.js";
import type { AssetInfo } from "../assets/info.js";
import type { WalletContext } from "../context.js";
import type { RelayerInfo } from "../relayer-info.js";
import type { WalletConfig } from "../types/config.js";
import { type DepositFee, depositSlots } from "./deposit-fee.js";

/**
 * A wrapper intent's `refundTo`: where the wrapper returns funds if an escrow is cancelled.
 * Covered by the withdraw proof's intent hash.
 *
 * Resolution order: the explicit `refundAddress`; the wallet's own EVM account when its chain
 * layer signs; the relayer's advertised refund address (`Submitter.refundAddress`, from `/chains`).
 * Throws if none is available, or if the address is one {@link wrapperReceiver} refuses.
 *
 * `op` prefixes the error messages.
 */
export async function resolveRefundAddress(
    ctx: {
        relayerInfo: Pick<RelayerInfo, "refundAddress">;
        cfg: Pick<WalletConfig, "chain" | "relayerAddress">;
    },
    explicit: string | undefined,
    wrapperAddress: EvmAddress,
    op = "swap",
): Promise<EvmAddress> {
    const { chain } = ctx.cfg;
    const raw =
        explicit ??
        (supportsSigning(chain) ? await chain.payerAddress() : undefined) ??
        (await ctx.relayerInfo.refundAddress());
    if (raw === undefined) {
        throw new InvalidArgumentError(
            `${op}: no refund address — pass \`refundAddress\`, connect an EVM account, or ` +
                "use a relayer that advertises `refundAddress`",
            { argument: "refundAddress" },
        );
    }
    return wrapperReceiver(ctx, raw, wrapperAddress, { op, argument: "refundAddress" });
}

/**
 * `raw` as an address a wrapper intent may name to receive funds (`refundTo`, `surplusTo`).
 *
 * The zero address, the wrapper and the relayer's Bundler (`cfg.relayerAddress`) are refused before
 * proving, matching the wrappers and the relayer: none of them can move what it receives.
 */
export function wrapperReceiver(
    ctx: { cfg: Pick<WalletConfig, "relayerAddress"> },
    raw: string,
    wrapperAddress: EvmAddress,
    as: { op: string; argument: string },
): EvmAddress {
    const address = evmAddress(raw);
    const stranded = [zeroAddress, wrapperAddress, ctx.cfg.relayerAddress];
    if (stranded.some((other) => isAddressEqual(abiAddress(address), abiAddress(other)))) {
        throw new InvalidArgumentError(
            `${as.op}: ${as.argument} ${address} cannot move what the wrapper sends it`,
            { argument: as.argument },
        );
    }
    return address;
}

/** The rate a yield asset's escrow note is priced at; nothing for a plain asset. */
export function yieldPricing(asset: Pick<AssetInfo, "yieldEnabled" | "rate">): YieldPricing {
    return asset.yieldEnabled ? { yieldEnabled: true, rate: asset.rate } : {};
}

/** One escrow: the note it mints, its flush fee, and who it credits. */
export interface EscrowSide {
    asset: { id: AssetId; scale: bigint };
    /** The note's value (`publicIn`). */
    value: bigint;
    fee: DepositFee;
    /** The shielded address the note credits. */
    recipient: DecodedAddress;
}

/**
 * One deposit a wrapper escrows. The wrapper is both the Permit2 payer and the on-chain recipient.
 *
 * A relayer flushes it later, and leg 1's fee does not cover that flush, which is priced per
 * deposit. An unpaid deposit is skipped with "fee note is not addressed to this relayer" and its
 * note never appears, so each escrow carries a flush fee in its own asset.
 *
 * `what` names the note in a `publicIn` range error.
 */
export function buildEscrow(
    ctx: Pick<WalletContext, "P" | "J" | "cfg" | "outgoingKey">,
    wrapperAddress: EvmAddress,
    side: EscrowSide,
    what: string,
): BuiltDeposit {
    assertPublicInFits(side.value, { what, asset: side.asset.id, scale: side.asset.scale });
    return buildDeposit({
        P: ctx.P,
        J: ctx.J,
        chainId: ctx.cfg.chainId,
        asset: side.asset.id,
        payerAddress: wrapperAddress,
        recipientAddress: wrapperAddress,
        publicIn: side.value,
        recipient: side.recipient,
        outgoingKey: ctx.outgoingKey,
        ...depositSlots(side.fee),
    });
}
