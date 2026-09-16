// Unshield, as a spend spec. Backs `wallet.withdraw`; `native` selects the ERC-20 or native-coin
// entry point.

import { type EvmAddress, evmAddress } from "../../core/brand.js";
import { UnsupportedOperationError } from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { isDenomination } from "../../protocol/denominations.js";
import {
    chargedMoney,
    precheckAmount,
    publicMoney,
    requireOutSide,
    resolveOutAmount,
    shieldedMoney,
} from "../assets/amount.js";
import type { WalletContext } from "../context.js";
import {
    detachedRun,
    landedBase,
    runSpend,
    type SpendBinding,
    type SpendRun,
} from "../tx/run-spend.js";
import type { WithdrawOptions } from "../types/options.js";
import type { WithdrawResult } from "../types/results.js";

export function executeWithdraw(
    ctx: WalletContext,
    args: WithdrawOptions,
    run: SpendRun = detachedRun("withdraw"),
): Promise<WithdrawResult> {
    const native = args.native === true;
    return runSpend(
        ctx,
        {
            options: args,
            async plan(ctx) {
                const side = requireOutSide(args, "withdraw");
                // Checked before the fee quote and selection: the pool rejects a zero unshield
                // only after a full proof.
                precheckAmount(args[side], side, "withdraw");
                const recipient = recipientOf(args.recipient);
                // Checked before selection, since a proof naming any other address would revert.
                const adapter = native ? nativeAdapter(ctx) : undefined;
                // Verified: scale, withdraw rate, index and ladder size what leaves the pool.
                const asset = await ctx.assets.resolveVerified(args.asset);
                // `gross` is `publicOut`, published on-chain, from which `MASP._unshieldLeg`
                // deducts the protocol fee; `net` grosses up to the smallest `publicOut` that
                // delivers it, rarely a denomination. The relayer's fee is a separate note.
                const out = resolveOutAmount(args, asset, "withdraw");
                return {
                    feeKind: native ? ("withdrawNative" as const) : ("withdraw" as const),
                    asset,
                    target: out.gross,
                    out,
                    recipient,
                    adapter,
                };
            },
            bind: (ctx, { target, recipient, adapter }) => ({
                ...bindingFor(ctx, recipient, adapter),
                publicOut: target,
            }),
            result: (_ctx, { asset, out, recipient }, landed): WithdrawResult => ({
                kind: "withdraw",
                ...landedBase(landed, asset),
                fees: Object.freeze({
                    protocol: chargedMoney(publicMoney(asset, out.fee)),
                    relayer: landed.relayerFee,
                }),
                gross: shieldedMoney(asset, out.gross),
                // On the receipt because recomputing it requires `scale`, fee rate and index as of
                // submission.
                net: publicMoney(asset, out.net),
                recipient,
                native,
                onLadder: isDenomination(out.gross, asset.ladder),
                spent: landed.spent,
                change: landed.change,
            }),
        },
        run,
    );
}

function recipientOf(recipient: unknown): EvmAddress {
    if (typeof recipient !== "string") {
        throw new InvalidArgumentError("withdraw: recipient must be a 0x EVM address", {
            argument: "recipient",
        });
    }
    try {
        return evmAddress(recipient);
    } catch (err) {
        throw new InvalidArgumentError((err as Error).message, {
            argument: "recipient",
            cause: err,
        });
    }
}

/** `NativeAdapter`, which a native withdraw is bound to; refused when the chain names none. */
function nativeAdapter(ctx: WalletContext): string {
    const adapter = ctx.cfg.chain.nativeAdapterAddress?.();
    if (!adapter) {
        throw new UnsupportedOperationError("withdraw:native", ["nativeAdapterAddress"]);
    }
    return adapter;
}

/**
 * Which contract calls the pool, and so what the proof binds.
 *
 * An ERC-20 unshield is submitted by the relayer, and the token goes to `recipient`. A native
 * unshield is submitted by `NativeAdapter`: the pool checks `pi.relayer == msg.sender`, and the
 * adapter must receive the WETH to unwrap it, so it is both `relayer` and `recipient` and forwards
 * the coin to `pi.payer`. Naming the relayer reverts `AdapterNotRelayer`; naming the recipient
 * reverts `AdapterNotRecipient`.
 */
function bindingFor(
    ctx: WalletContext,
    recipient: EvmAddress,
    adapter: string | undefined,
): SpendBinding {
    if (adapter === undefined) {
        const relayer = ctx.cfg.relayerAddress;
        return { kind: "withdraw", payer: relayer, relayer, recipient };
    }
    return { kind: "withdrawNative", payer: recipient, relayer: adapter, recipient: adapter };
}
