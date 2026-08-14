// Deposit submission and cancellation.
//
// The three submit paths (witness / native / authorized) each encode their own
// calldata — viem infers the argument tuple from the ABI, so a struct that
// drifts from the contract is a compile error — then share the send/receipt/
// log-extraction tail.
//
// Two of them go to the pool. The native one goes to `NativeAdapter`: MASP is
// ERC-20 only, so the adapter wraps `msg.value`, escrows the WETH under its
// own name, and returns the excess. Its escrow is adapter-owned, which is why
// the native cancel is a different call as well.

import { encodeFunctionData, type Hex, parseEventLogs } from "viem";
import type { EvmAddress, Hex32 } from "../../core/brand.js";
import { safeCall } from "../../core/callbacks.js";
import { TxMiningError, WalletConfigError } from "../../core/errors.js";
import type { AuxOutput, DepositRequest, Permit2Sig } from "../../protocol/deposit-request.js";
import type { CancelDepositInputs } from "../types.js";
import { MASP_ABI, NATIVE_ADAPTER_ABI } from "./abi.js";
import { hex, type ViemCtx } from "./ctx.js";
import { waitTxReceipt } from "./token.js";
import { auxTuple, depositTuple } from "./tuples.js";

export interface SubmitBase {
    deposit: DepositRequest;
    aux: AuxOutput;
    onSent?: ((txHash: Hex32) => void) | undefined;
}

/** `MASP.deposit(d, sig, aux)` — Permit2 witness, one signature per deposit. */
export function submitDeposit(
    ctx: ViemCtx,
    args: SubmitBase & { permit2: Permit2Sig },
): Promise<{ txHash: Hex32; depositId: bigint }> {
    const data = encodeFunctionData({
        abi: MASP_ABI,
        functionName: "deposit",
        args: [
            depositTuple(args.deposit),
            {
                nonce: args.permit2.nonce,
                deadline: args.permit2.deadline,
                maxTotal: args.permit2.maxTotal,
                signature: hex(args.permit2.signature),
            },
            auxTuple(args.aux),
        ],
    });
    return sendAndExtractDepositId(ctx, ctx.maspAddress, data, args.onSent);
}

/**
 * `NativeAdapter.depositNative(d, aux)` with `msg.value = value`.
 *
 * `deposit.payer` must be the adapter — it wraps the coin and the pool pulls
 * against *its* allowance, so a request naming the sender reverts
 * `AdapterNotPayer`. `deposit.recipient` and `outCm` still bind the note to
 * the depositor, so the adapter learns nothing the pool does not.
 *
 * Overshooting `value` is fine: the adapter unwraps and returns whatever the
 * pool did not pull, so callers need not mirror the fee math.
 */
// `async` so a missing adapter rejects rather than throwing synchronously:
// every other path here fails through the returned promise, and a caller
// using `.catch()` would otherwise miss this one.
export async function submitDepositNative(
    ctx: ViemCtx,
    args: SubmitBase & { value: bigint },
): Promise<{ txHash: Hex32; depositId: bigint }> {
    const adapter = requireNativeAdapter(ctx);
    const data = encodeFunctionData({
        abi: NATIVE_ADAPTER_ABI,
        functionName: "depositNative",
        args: [depositTuple(args.deposit), auxTuple(args.aux)],
    });
    return sendAndExtractDepositId(ctx, adapter, data, args.onSent, args.value);
}

/** `MASP.depositAuthorized(d, aux)` — pulls against a signed Permit2 window. */
export function submitDepositAuthorized(
    ctx: ViemCtx,
    args: SubmitBase,
): Promise<{ txHash: Hex32; depositId: bigint }> {
    const data = encodeFunctionData({
        abi: MASP_ABI,
        functionName: "depositAuthorized",
        args: [depositTuple(args.deposit), auxTuple(args.aux)],
    });
    return sendAndExtractDepositId(ctx, ctx.maspAddress, data, args.onSent);
}

async function sendAndExtractDepositId(
    ctx: ViemCtx,
    to: EvmAddress,
    data: Hex,
    onSent?: (txHash: Hex32) => void,
    value?: bigint,
): Promise<{ txHash: Hex32; depositId: bigint }> {
    const hash = await ctx.signer.sendTransaction({
        to,
        data,
        ...(value !== undefined ? { value } : {}),
    });
    safeCall("onSent", onSent, hash);

    const receipt = await ctx.publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: 1000,
        timeout: 300_000,
    });
    // Emitted by the pool on every path, the adapter's included — the adapter
    // escrows through `depositAuthorized`, so the id is the pool's.
    const events = parseEventLogs({
        abi: MASP_ABI,
        eventName: "DepositEscrowed",
        logs: receipt.logs,
    });
    if (events.length === 0) {
        // Carry the hash: the transaction mined, so the caller needs it to
        // inspect what happened.
        throw new TxMiningError("deposit: DepositEscrowed log not found", { txHash: hash });
    }
    return { txHash: hash, depositId: (events[0]!.args as { id: bigint }).id };
}

/**
 * `MASP.cancelDeposit` — refunds the digest-bound payer after `cancelDelay`.
 *
 * For an adapter-owned escrow use {@link cancelDepositNative}: the pool would
 * refund the adapter, which holds the only record of who funded it.
 */
export async function cancelDeposit(
    ctx: ViemCtx,
    id: bigint,
    inputs: CancelDepositInputs,
): Promise<{ txHash: Hex32 }> {
    const data = encodeFunctionData({
        abi: MASP_ABI,
        functionName: "cancelDeposit",
        // The contract keeps only `keccak(deposit)` per escrow, so the fields
        // it used to read from storage are now supplied by the caller and
        // checked against that digest. They come off the `DepositEscrowed` log.
        args: [
            id,
            // `uint48`, so viem wants a JS number. Lossless: 2^48 is well
            // inside the safe-integer range.
            Number(inputs.publicIn),
            hex(inputs.cm),
            [inputs.cvDep[0], inputs.cvDep[1]],
            inputs.publicAssetId,
            inputs.feeBpsAtSubmit,
            hex(inputs.payer),
            inputs.submittedAt,
        ],
    });
    const hash = await ctx.signer.sendTransaction({ to: ctx.maspAddress, data });
    await waitTxReceipt(ctx, hash);
    return { txHash: hash };
}

/**
 * `NativeAdapter.cancelNative` — cancels an adapter-owned escrow and forwards
 * the refund as native coin to whoever funded it.
 *
 * Takes no `payer`: the adapter is the payer, and it supplies its own address
 * to the pool's digest check. Permissionless, like the ERC-20 cancel.
 */
export async function cancelDepositNative(
    ctx: ViemCtx,
    id: bigint,
    inputs: Omit<CancelDepositInputs, "payer">,
): Promise<{ txHash: Hex32 }> {
    const adapter = requireNativeAdapter(ctx);
    const data = encodeFunctionData({
        abi: NATIVE_ADAPTER_ABI,
        functionName: "cancelNative",
        args: [
            id,
            Number(inputs.publicIn),
            hex(inputs.cm),
            [inputs.cvDep[0], inputs.cvDep[1]],
            inputs.publicAssetId,
            inputs.feeBpsAtSubmit,
            inputs.submittedAt,
        ],
    });
    const hash = await ctx.signer.sendTransaction({ to: adapter, data });
    await waitTxReceipt(ctx, hash);
    return { txHash: hash };
}

function requireNativeAdapter(ctx: ViemCtx): EvmAddress {
    if (!ctx.nativeAdapterAddress) {
        throw new WalletConfigError(
            "nativeAdapterAddress is required for native-coin deposits: the MASP pool is ERC-20 only, so there is no pool entry point to fall back to",
        );
    }
    return ctx.nativeAdapterAddress;
}
