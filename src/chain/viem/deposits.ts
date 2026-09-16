// Deposit submission and cancellation.
//
// The three submit paths (witness / native / authorized) each encode their own
// calldata (viem infers the argument tuple from the ABI, so a struct that
// drifts from the contract is a compile error), then share the send/receipt/
// log-extraction tail.
//
// Two of them go to the pool. The native one goes to `NativeAdapter`: MASP is
// ERC-20 only, so the adapter wraps `msg.value`, escrows the WETH under its
// own name, and returns the excess. The escrow is adapter-owned, so the native
// cancel is also a separate call.

import {
    encodeFunctionData,
    type Hex,
    isAddressEqual,
    type ParseEventLogsReturnType,
    parseEventLogs,
    type TransactionReceipt,
} from "viem";
import { type AssetId, branded, type EvmAddress, type Hex32 } from "../../core/brand.js";
import { TxMiningError } from "../../errors/chain.js";
import { WalletConfigError } from "../../errors/config.js";
import {
    type AuxOutput,
    auxTuple,
    type DepositRequest,
    depositTuple,
    type Permit2Sig,
} from "../../protocol/deposit-request.js";
import type { CancelDepositInputs, CancelDepositReceipt, DepositSubmitted } from "../types.js";
import { MASP_ABI, NATIVE_ADAPTER_ABI } from "./abi.js";
import { hex, type ViemCtx } from "./ctx.js";
import { depositEscrowedRecord } from "./reads.js";
import { sendAndConfirm } from "./token.js";

interface SubmitBase {
    deposit: DepositRequest;
    aux: AuxOutput;
    /** The relayer's fee note payload; the second leaf a deposit mints. */
    feeAux: AuxOutput;
    onSent?: ((txHash: Hex32) => void) | undefined;
}

/**
 * `MASP.deposit(d, sig, aux, feeAux)` — Permit2 witness, one signature per
 * deposit. The signature is single-token or a two-token batch according to
 * `d.feeAssetId`; `sig.maxFee` is `0n` for the former.
 */
export function submitDeposit(
    ctx: ViemCtx,
    args: SubmitBase & { permit2: Permit2Sig },
): Promise<DepositSubmitted> {
    const data = encodeFunctionData({
        abi: MASP_ABI,
        functionName: "deposit",
        args: [
            depositTuple(args.deposit),
            {
                nonce: args.permit2.nonce,
                deadline: args.permit2.deadline,
                maxTotal: args.permit2.maxTotal,
                maxFee: args.permit2.maxFee,
                signature: hex(args.permit2.signature),
            },
            auxTuple(args.aux),
            auxTuple(args.feeAux),
        ],
    });
    return sendAndExtractDepositId(ctx, ctx.maspAddress, data, args.onSent);
}

/**
 * `NativeAdapter.depositNative(d, aux)` with `msg.value = value`.
 *
 * `deposit.payer` must be the adapter: it wraps the coin and the pool pulls
 * against *its* allowance, so a request naming the sender reverts
 * `AdapterNotPayer`. `deposit.recipient` and `outCm` still bind the note to
 * the depositor, so the adapter learns nothing the pool does not.
 *
 * Overshooting `value` is safe: the adapter unwraps and returns whatever the
 * pool did not pull, so callers need not mirror the fee math.
 */
// `async` so a missing adapter rejects rather than throwing synchronously:
// every other path here fails through the returned promise, and a caller
// using `.catch()` would otherwise miss this one.
export async function submitDepositNative(
    ctx: ViemCtx,
    args: SubmitBase & { value: bigint },
): Promise<DepositSubmitted> {
    const adapter = requireNativeAdapter(ctx);
    const data = encodeFunctionData({
        abi: NATIVE_ADAPTER_ABI,
        functionName: "depositNative",
        args: [depositTuple(args.deposit), auxTuple(args.aux), auxTuple(args.feeAux)],
    });
    return sendAndExtractDepositId(ctx, adapter, data, args.onSent, args.value);
}

/** `MASP.depositAuthorized(d, aux)` — pulls against a signed Permit2 window. */
export function submitDepositAuthorized(ctx: ViemCtx, args: SubmitBase): Promise<DepositSubmitted> {
    const data = encodeFunctionData({
        abi: MASP_ABI,
        functionName: "depositAuthorized",
        args: [depositTuple(args.deposit), auxTuple(args.aux), auxTuple(args.feeAux)],
    });
    return sendAndExtractDepositId(ctx, ctx.maspAddress, data, args.onSent);
}

async function sendAndExtractDepositId(
    ctx: ViemCtx,
    to: EvmAddress,
    data: Hex,
    onSent?: (txHash: Hex32) => void,
    value?: bigint,
): Promise<DepositSubmitted> {
    const tx = value === undefined ? { to, data } : { to, data, value };
    const { txHash, receipt } = await sendAndConfirm(ctx, tx, "deposit", onSent, "onSent");
    // Emitted by the pool on every path, including the adapter's, which
    // escrows through `depositAuthorized`; the id is the pool's.
    const event = poolEvent(ctx, txHash, receipt, "DepositEscrowed", "deposit");
    const escrowed = await depositEscrowedRecord(ctx, event.args, receipt.blockNumber);
    return {
        txHash,
        depositId: escrowed.id,
        blockNumber: Number(receipt.blockNumber),
        escrowed,
    };
}

/**
 * The pool's `eventName` log in a mined receipt, the first `match` accepts. Filtered to the pool's
 * address: nothing else may speak for an escrow.
 *
 * @throws {TxMiningError} when absent, carrying the hash: the transaction mined, so the caller
 * needs it to inspect what happened.
 */
function poolEvent<N extends "DepositEscrowed" | "DepositCanceled">(
    ctx: ViemCtx,
    txHash: Hex32,
    receipt: TransactionReceipt,
    eventName: N,
    op: string,
    match: (log: ParseEventLogsReturnType<typeof MASP_ABI, N>[number]) => boolean = () => true,
) {
    const event = parseEventLogs({ abi: MASP_ABI, eventName, logs: receipt.logs }).find(
        (l) => isAddressEqual(l.address, ctx.maspAddress) && match(l),
    );
    if (!event) {
        throw new TxMiningError(`${op}: ${eventName} log not found`, { txHash });
    }
    return event;
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
): Promise<CancelDepositReceipt> {
    const data = encodeFunctionData({
        abi: MASP_ABI,
        functionName: "cancelDeposit",
        // The contract keeps only `keccak(deposit)` per escrow, so the caller
        // supplies every field and the contract checks them against that
        // digest. They come off the `DepositEscrowed` log.
        args: [
            id,
            // `uint48`, so viem wants a JS number. Lossless: 2^48 is within
            // the safe-integer range.
            Number(inputs.publicIn),
            hex(inputs.cm),
            [inputs.cvDep[0], inputs.cvDep[1]],
            inputs.publicAssetId,
            inputs.feeBpsAtSubmit,
            hex(inputs.payer),
            inputs.submittedAt,
            // The relayer's leaf is bound into the same digest, so cancel has
            // to resupply it too, `feeAssetId` included.
            feeNoteTuple(inputs),
        ],
    });
    return confirmCancel(ctx, id, { to: ctx.maspAddress, data });
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
): Promise<CancelDepositReceipt> {
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
            // The relayer's leaf is bound into the same digest, so cancel has
            // to resupply it too, `feeAssetId` included.
            feeNoteTuple(inputs),
        ],
    });
    return confirmCancel(ctx, id, { to: adapter, data });
}

/**
 * `PubInputs.FeeNote`: the relayer leaf as the escrow digest hashes it.
 *
 * One struct, not flattened fields: a `FeeNote` of static members encodes
 * identically either way, but the selector does not, so a flattened signature
 * calls a function that does not exist.
 */
function feeNoteTuple(inputs: Omit<CancelDepositInputs, "payer">) {
    return {
        // `uint48`, so viem wants a JS number. Lossless: 2^48 is within the
        // safe-integer range.
        feeIn: Number(inputs.feeIn),
        feeAssetId: inputs.feeAssetId,
        feeCm: hex(inputs.feeCm),
        feeCvDep: [inputs.feeCvDep[0], inputs.feeCvDep[1]] as [bigint, bigint],
    };
}

/**
 * Send a cancel and read what it refunded off the pool's `DepositCanceled`
 * log.
 *
 * Matched to this id: on the native path the adapter emits its own events in
 * the same receipt, and only the pool's carries the per-token split.
 */
async function confirmCancel(
    ctx: ViemCtx,
    id: bigint,
    tx: { to: EvmAddress; data: Hex },
): Promise<CancelDepositReceipt> {
    const { txHash, receipt } = await sendAndConfirm(ctx, tx, "cancelDeposit");
    const event = poolEvent(
        ctx,
        txHash,
        receipt,
        "DepositCanceled",
        "cancelDeposit",
        (l) => l.args.id === id,
    );
    return {
        txHash,
        refunded: event.args.refunded,
        feeAssetId: branded<AssetId>(event.args.feeAssetId),
        feeRefunded: event.args.feeRefunded,
    };
}

function requireNativeAdapter(ctx: ViemCtx): EvmAddress {
    if (!ctx.nativeAdapterAddress) {
        throw new WalletConfigError(
            "nativeAdapterAddress is required for native-coin deposits: the MASP pool is ERC-20 only, so there is no pool entry point to fall back to",
        );
    }
    return ctx.nativeAdapterAddress;
}
