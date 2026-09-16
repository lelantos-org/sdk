// Reclaiming an unflushed escrow. Backs `wallet.cancelDeposit`.

import { supportsSigning } from "../../chain/port.js";
import type { CancelDepositInputs, CancelDepositReceipt } from "../../chain/types.js";
import { NoEvmAccountError, UnsupportedOperationError } from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { publicMoney } from "../assets/amount.js";
import type { AssetInfo } from "../assets/info.js";
import type { WalletContext } from "../context.js";
import { cancelInputsOf, isNativeEscrowPayer } from "../tx/escrow.js";
import type { CancelDepositTarget, DepositPhase, OpRun } from "../types/options.js";
import type { CancelDepositResult } from "../types/results.js";

/**
 * Blocks looked back past the cancel delay when finding an escrow's log by id: a cancellable escrow
 * is at least `cancelDelay` old, so the adapter's recent-window default would never reach it.
 */
const LOG_LOOKBACK_MARGIN = 3_600;

/**
 * Cancel the escrow `target` names: a `DepositEscrow` a deposit returned (its `cancelInputs` are
 * used as-is), or `{ depositId }`, whose inputs are rebuilt from the pool's `DepositEscrowed` log.
 * An adapter-owned escrow (a native deposit) is cancelled through `NativeAdapter`.
 */
export async function executeCancelDeposit(
    ctx: WalletContext,
    target: CancelDepositTarget,
    run: OpRun<DepositPhase>,
    signal?: AbortSignal | undefined,
): Promise<CancelDepositResult> {
    if (typeof target !== "object" || target === null) {
        throw new InvalidArgumentError("cancelDeposit: pass a DepositEscrow or { depositId }", {
            argument: "target",
        });
    }
    const chain = ctx.cfg.chain;
    if (!supportsSigning(chain)) throw new NoEvmAccountError({ operation: "cancelDeposit" });
    const { depositId } = target;
    if (typeof depositId !== "bigint" || depositId < 0n) {
        throw new InvalidArgumentError("cancelDeposit: depositId must be a non-negative bigint", {
            argument: "depositId",
        });
    }
    const fromBlockArg: unknown = "fromBlock" in target ? target.fromBlock : undefined;
    if (fromBlockArg !== undefined && typeof fromBlockArg !== "bigint") {
        throw new InvalidArgumentError("cancelDeposit: fromBlock must be a bigint", {
            argument: "fromBlock",
        });
    }
    run.phase("preparing");

    const given = "cancelInputs" in target ? target.cancelInputs : undefined;
    let inputs: CancelDepositInputs;
    if (given !== undefined) {
        inputs = checkInputs(given);
    } else {
        if (!chain.fetchDepositEscrowed) {
            throw new UnsupportedOperationError("cancelDeposit:by-id", [
                "chain.fetchDepositEscrowed",
            ]);
        }
        const fromBlock = (fromBlockArg as bigint | undefined) ?? (await lookbackFrom(ctx));
        const record = await chain.fetchDepositEscrowed(depositId, fromBlock);
        if (record === null) {
            throw new InvalidArgumentError(
                "cancelDeposit: no DepositEscrowed log for this depositId in the searched blocks; " +
                    "pass the DepositEscrow the deposit returned, or an earlier `fromBlock`",
                { argument: "depositId" },
            );
        }
        inputs = cancelInputsOf(record);
    }
    const native =
        ("native" in target && target.native === true) || isNativeEscrowPayer(chain, inputs.payer);

    // The pool reverts a cancel of a flushed or cancelled escrow; say so without spending gas.
    if (chain.getEscrowed && (await chain.getEscrowed(depositId)) === null) {
        throw new InvalidArgumentError(
            "cancelDeposit: this escrow is not pending: it was flushed or already cancelled",
            { argument: "depositId" },
        );
    }
    // Resolved before sending, so a failed read cannot hide a cancel that landed.
    const asset = await ctx.assets.resolveVerified(inputs.publicAssetId);
    const feeAsset =
        inputs.feeIn > 0n && inputs.feeAssetId !== inputs.publicAssetId
            ? await ctx.assets.resolveVerified(inputs.feeAssetId)
            : undefined;
    signal?.throwIfAborted();

    run.phase("submitting");
    let r: CancelDepositReceipt;
    if (native) {
        if (!chain.cancelDepositNative) {
            throw new UnsupportedOperationError("cancelDeposit:native", [
                "chain.cancelDepositNative",
            ]);
        }
        const { payer: _, ...rest } = inputs;
        r = await chain.cancelDepositNative(depositId, rest);
    } else {
        if (!chain.cancelDeposit) {
            throw new UnsupportedOperationError("cancelDeposit", ["chain.cancelDeposit"]);
        }
        r = await chain.cancelDeposit(depositId, inputs);
    }
    run.phase("confirmed", r.txHash);

    let refundAsset: AssetInfo | undefined;
    if (r.feeRefunded > 0n) {
        refundAsset =
            feeAsset?.id === r.feeAssetId
                ? feeAsset
                : await ctx.assets.resolveVerified(r.feeAssetId);
    }
    return Object.freeze({
        kind: "cancelDeposit" as const,
        opId: run.opId,
        txHash: r.txHash,
        depositId,
        native,
        refunded: publicMoney(asset, r.refunded),
        feeRefunded: refundAsset ? publicMoney(refundAsset, r.feeRefunded) : null,
    });
}

/** The tip minus the cancel delay and a margin, when the chain can say; else the adapter's default. */
async function lookbackFrom(ctx: WalletContext): Promise<bigint | undefined> {
    const { chain } = ctx.cfg;
    if (!chain.blockNumber || !chain.cancelDelay) return undefined;
    const [tip, delay] = await Promise.all([chain.blockNumber(), chain.cancelDelay()]);
    const from = tip - delay - LOG_LOOKBACK_MARGIN;
    return BigInt(from > 0 ? from : 0);
}

/** A caller-held `cancelInputs`, checked for the shape the pool's digest needs. */
function checkInputs(v: unknown): CancelDepositInputs {
    const i = v as Partial<Record<keyof CancelDepositInputs, unknown>>;
    const big = (x: unknown) => typeof x === "bigint";
    const hex = (x: unknown) => typeof x === "string" && /^0x[0-9a-fA-F]+$/.test(x);
    const pair = (x: unknown) => Array.isArray(x) && x.length === 2 && x.every(big);
    const ok =
        typeof v === "object" &&
        v !== null &&
        big(i.publicIn) &&
        hex(i.cm) &&
        pair(i.cvDep) &&
        big(i.publicAssetId) &&
        Number.isInteger(i.feeBpsAtSubmit) &&
        hex(i.payer) &&
        Number.isInteger(i.submittedAt) &&
        big(i.feeIn) &&
        big(i.feeAssetId) &&
        hex(i.feeCm) &&
        pair(i.feeCvDep);
    if (!ok) {
        throw new InvalidArgumentError(
            "cancelDeposit: cancelInputs is not the DepositEscrowed payload a deposit returned",
            { argument: "cancelInputs" },
        );
    }
    return v as CancelDepositInputs;
}
