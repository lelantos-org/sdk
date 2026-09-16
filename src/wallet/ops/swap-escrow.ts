// A swap's second leg: the deposits `SwapWrapper` escrows, and where a cancelled swap refunds to.

import { isAddressEqual, zeroAddress } from "viem";
import { type BuiltDeposit, buildDeposit } from "../../bundle/deposit.js";
import { supportsSigning } from "../../chain/port.js";
import { type AssetId, type EvmAddress, evmAddress } from "../../core/brand.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { decodeAddress } from "../../keys/address.js";
import { abiAddress } from "../../protocol/deposit-request.js";
import { assertPublicInFits } from "../../protocol/fees.js";
import type { WalletContext } from "../context.js";
import type { RelayerInfo } from "../relayer-info.js";
import { type DepositFee, depositSlots } from "../tx/deposit-fee.js";
import type { WalletConfig } from "../types/config.js";

/**
 * The swap's `refundTo`: where `SwapWrapper` returns funds if the output escrow is cancelled.
 * Covered by the withdraw proof's intent hash.
 *
 * Resolution order: the explicit `refundAddress`; the wallet's own EVM account when its chain
 * layer signs; the relayer's advertised refund address (`Submitter.refundAddress`, from `/chains`).
 * Throws if none is available. The zero address, the wrapper and the relayer's Bundler
 * (`cfg.relayerAddress`) are rejected before proving, matching `SwapWrapper` and the relayer.
 */
export async function resolveRefundAddress(
    ctx: {
        relayerInfo: Pick<RelayerInfo, "refundAddress">;
        cfg: Pick<WalletConfig, "chain" | "relayerAddress">;
    },
    explicit: string | undefined,
    wrapperAddress: EvmAddress,
): Promise<EvmAddress> {
    const { chain } = ctx.cfg;
    const raw =
        explicit ??
        (supportsSigning(chain) ? await chain.payerAddress() : undefined) ??
        (await ctx.relayerInfo.refundAddress());
    if (raw === undefined) {
        throw new InvalidArgumentError(
            "swap: no refund address — pass `refundAddress`, connect an EVM account, or " +
                "use a relayer that advertises `refundAddress`",
            { argument: "refundAddress" },
        );
    }
    const address = evmAddress(raw);
    // Addresses that cannot move a refund, as enforced by the relayer and the wrapper.
    const stranded = [zeroAddress, wrapperAddress, ctx.cfg.relayerAddress];
    if (stranded.some((other) => isAddressEqual(abiAddress(address), abiAddress(other)))) {
        throw new InvalidArgumentError(`swap: refund address ${address} cannot return a refund`, {
            argument: "refundAddress",
        });
    }
    return address;
}

/** One escrow of a swap: the note it mints, its flush fee, and who it credits. */
interface EscrowSide {
    asset: { id: AssetId; scale: bigint };
    /** The note's value (`publicIn`), sized by `swapLegs`. */
    value: bigint;
    fee: DepositFee;
    /** Bech32m address the note credits. */
    recipientAddress: string;
}

/**
 * The two deposits `SwapWrapper` may escrow: the output note, and the refund note escrowed instead
 * when the venue leg fails. The wrapper is both the Permit2 payer and the on-chain recipient of
 * each.
 *
 * A relayer flushes both later, and leg 1's fee (`EntryPoint::Swap`) does not cover that flush,
 * which is priced per deposit. An unpaid deposit is skipped with "fee note is not addressed to
 * this relayer" and its note never appears, so each carries a flush fee in its own asset.
 */
export function buildSwapEscrows(
    ctx: Pick<WalletContext, "P" | "J" | "cfg">,
    wrapperAddress: EvmAddress,
    a: { output: EscrowSide; refund: EscrowSide },
): { output: BuiltDeposit; refund: BuiltDeposit } {
    const build = (side: EscrowSide, what: string) => {
        assertPublicInFits(side.value, { what, asset: side.asset.id, scale: side.asset.scale });
        return buildDeposit({
            P: ctx.P,
            J: ctx.J,
            chainId: ctx.cfg.chainId,
            asset: side.asset.id,
            payerAddress: wrapperAddress,
            recipientAddress: wrapperAddress,
            publicIn: side.value,
            recipient: decodeAddress(ctx.J, side.recipientAddress),
            ...depositSlots(side.fee),
        });
    };
    return {
        output: build(a.output, "swap output-note publicIn"),
        refund: build(a.refund, "swap refund-note publicIn"),
    };
}
