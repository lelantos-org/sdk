// Atomic shielded execution of arbitrary calls through `GenericCallWrapper`, as a spend spec.
//
// Leg 1 is a withdraw of the input asset to the wrapper. Leg 2 runs `calls` from a single-use
// clone holding what leg 1 delivered. Leg 3 escrows each output back into the pool, or the refund
// note when leg 2 fails. The calls, outputs, refund, deadline, gas floor and receivers are hashed
// into the withdraw proof's `intentHash`, so the relayer can change none of them.
//
// Operations build on this; it is not part of the wallet's public surface.

import type { BuiltDeposit } from "../../bundle/deposit.js";
import {
    type CircuitAmount,
    type EvmAddress,
    evmAddress,
    type Hex32,
    type TokenAmount,
} from "../../core/brand.js";
import { fieldToBytes32 } from "../../core/hex.js";
import { UnsupportedOperationError } from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import type { DecodedAddress } from "../../keys/address.js";
import { genericIntentHash } from "../../protocol/abi-hash.js";
import { auxOutputFromWire } from "../../protocol/aux-wire.js";
import { depositTotal } from "../../protocol/fees.js";
import { sizeBNote, sizeRefundNote } from "../../protocol/swap-sizing.js";
import type { GenericBlob, GenericCall, SubmitGenericPayload } from "../../protocol/transact.js";
import type { ResolvedOutAmount } from "../assets/amount.js";
import type { AssetInfo } from "../assets/info.js";
import { GENERIC_DEFAULT_DEADLINE_SECS } from "../constants.js";
import type { WalletContext } from "../context.js";
import type { Money } from "../types/results.js";
import { assertBeforeDeadline, deadlineOrDefault } from "./deadline.js";
import { type DepositFee, resolveDepositFees } from "./deposit-fee.js";
import { buildEscrow, resolveRefundAddress, wrapperReceiver, yieldPricing } from "./escrows.js";
import { landedBase, runSpend, type SpendRun, type SpendRunOptions } from "./run-spend.js";

/** `GenericCallWrapper.MAX_OUTPUTS`. */
const MAX_OUTPUTS = 4;
/** `GenericCallWrapper.MAX_CALLS`. */
const MAX_CALLS = 16;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BLOB = /^0x([0-9a-fA-F]{2})*$/;

/** One note the calls must produce. */
export interface GenericOutputSpec {
    /** Chain-verified. Yield assets are refused by the wrapper. */
    asset: AssetInfo;
    /** Token base units the calls return to the wrapper in `asset`'s token. */
    tokens: TokenAmount;
    /**
     * How the note is sized against `tokens`:
     *
     * - `"floor"`: `tokens` is a lower bound on a variable return. The note is the smallest whose
     *   pull covers it; anything the calls return above the pull goes to `surplusTo`.
     * - `"exact"`: the calls return exactly `tokens`. The note is the largest whose pull fits.
     */
    sizing: "floor" | "exact";
    /** The shielded address the note credits. */
    recipient: DecodedAddress;
}

export interface GenericCallArgs {
    /** Prefixes error messages. */
    op: string;
    /** The input asset, chain-verified. */
    asset: AssetInfo;
    /** Leg 1: what leaves the pool and what the wrapper receives. */
    out: ResolvedOutAmount;
    calls: readonly GenericCall[];
    /** One to four, of distinct tokens. */
    outputs: readonly GenericOutputSpec[];
    /** Gas the call leg must be forwarded. The relayer's fee is quoted for it. */
    minGas: bigint;
    /** Where a cancelled escrow refunds to. Default: as `resolveRefundAddress`. */
    refundTo?: string | undefined;
    /** Receives unused input, slippage cushions and native leftovers. Default: `refundTo`. */
    surplusTo?: string | undefined;
    /** Intent expiry, unix seconds. Default: now + `GENERIC_DEFAULT_DEADLINE_SECS`. */
    deadline?: bigint | undefined;
}

export interface GenericCallResult {
    opId: string;
    asset: AssetInfo;
    txHash: Hex32;
    commitments: Hex32[];
    ownCommitments: Hex32[];
    nonZeroCommitments: Hex32[];
    /** The output notes, in `outputs` order. They appear after the relayer's flush, if leg 2 landed. */
    outputCommitments: Hex32[];
    /** Each output note's value. */
    outputCredits: CircuitAmount[];
    /** The refund note. It appears instead of the outputs if leg 2 failed. */
    refundCommitment: Hex32;
    refundCredit: CircuitAmount;
    deadline: bigint;
    spent: string[];
    change: CircuitAmount;
    /** The pool's fee on leg 1, in base units of `asset`. */
    protocolFee: TokenAmount;
    /** The relayer's fee note, in the asset that paid it; `null` when none was charged. */
    relayerFee: Money | null;
}

/** `GenericCallWrapper`: the preset's, else the relayer's advertised one. */
export async function resolveGenericCallWrapper(
    ctx: Pick<WalletContext, "cfg" | "relayerInfo">,
    op: string,
): Promise<EvmAddress> {
    const raw =
        ctx.cfg.genericCallWrapperAddress ?? (await ctx.relayerInfo.genericCallWrapperAddress());
    if (!raw) {
        throw new UnsupportedOperationError(op, [
            "a GenericCallWrapper address (`genericCallWrapperAddress` in the network preset, or the relayer's /chains)",
        ]);
    }
    return evmAddress(raw);
}

export function executeGenericCall(
    ctx: WalletContext,
    args: GenericCallArgs,
    options: SpendRunOptions,
    run: SpendRun,
): Promise<GenericCallResult> {
    const { op, asset, out } = args;
    // Filled in by `bind`, read by `result`.
    let bound: { outputs: BuiltDeposit[]; refund: BuiltDeposit; deadline: bigint };
    return runSpend(
        ctx,
        {
            options,
            async plan(ctx) {
                // Bound here because `submitGeneric` is optional on `Submitter` and type narrowing
                // does not carry into the submit closure.
                const { submitter } = ctx.cfg;
                const submitGeneric = submitter.submitGeneric?.bind(submitter);
                if (!submitGeneric) {
                    throw new UnsupportedOperationError(op, ["submitter.submitGeneric"]);
                }
                checkShape(args);
                const wrapper = await resolveGenericCallWrapper(ctx, op);
                const refundTo = await resolveRefundAddress(ctx, args.refundTo, wrapper, op);
                const surplusTo =
                    args.surplusTo === undefined
                        ? refundTo
                        : wrapperReceiver(ctx, args.surplusTo, wrapper, {
                              op,
                              argument: "surplusTo",
                          });
                // One flush fee per escrow, each in its own asset; the refund's is last.
                const fees = await resolveDepositFees(ctx, [
                    ...args.outputs.map((o) => o.asset.id),
                    asset.id,
                ]);
                const refundFee = fees[args.outputs.length] as DepositFee;
                const outputs = args.outputs.map((spec, i) =>
                    sizeOutput(op, i, spec, fees[i] as DepositFee),
                );
                const refundCredit = sizeRefundNote(
                    out.net,
                    asset.scale,
                    asset.depositBps,
                    refundFee.value,
                    yieldPricing(asset),
                );
                if (refundCredit <= 0n) {
                    throw new InvalidArgumentError(
                        `${op}: leg 1 delivers ${out.net}, too little to refund after fees (zero refund note)`,
                        { argument: out.side },
                    );
                }
                return {
                    feeKind: "generic" as const,
                    feeEstimate: { minGas: args.minGas },
                    asset,
                    target: out.gross,
                    wrapper,
                    refundTo,
                    surplusTo,
                    outputs,
                    refund: { value: refundCredit as CircuitAmount, fee: refundFee },
                    submitGeneric,
                };
            },
            bind(ctx, plan) {
                const { wrapper } = plan;
                // The escrows are built first because leg 1's proof binds a hash over them.
                const outputs = plan.outputs.map((o, i) =>
                    buildEscrow(
                        ctx,
                        wrapper,
                        {
                            asset: o.spec.asset,
                            value: o.value,
                            fee: o.fee,
                            recipient: o.spec.recipient,
                        },
                        `${op} output-note ${i} publicIn`,
                    ),
                );
                const refund = buildEscrow(
                    ctx,
                    wrapper,
                    {
                        asset,
                        value: plan.refund.value,
                        fee: plan.refund.fee,
                        recipient: ctx.ownAddress,
                    },
                    `${op} refund-note publicIn`,
                );
                // Computed here, after selection and any auto-consolidation, so they do not
                // shorten the intent's window.
                const deadline = deadlineOrDefault(args.deadline, GENERIC_DEFAULT_DEADLINE_SECS);
                assertBeforeDeadline(deadline);
                bound = { outputs, refund, deadline };
                const generic: GenericBlob = {
                    amountIn: out.net,
                    calls: args.calls.map((c) => ({ ...c })),
                    outputs: outputs.map((built, i) => ({
                        minOut: (plan.outputs[i] as SizedOutput).minOut,
                        deposit: built.deposit,
                        aux: auxOutputFromWire(built.aux),
                        feeAux: auxOutputFromWire(built.feeAux),
                    })),
                    deadline,
                    minGas: args.minGas,
                    refundTo: plan.refundTo,
                    surplusTo: plan.surplusTo,
                    refundD: refund.deposit,
                    refundAuxD: auxOutputFromWire(refund.aux),
                    refundFeeAuxD: auxOutputFromWire(refund.feeAux),
                };
                // `relayer` and `recipient` are the wrapper: it calls `MASP.withdraw`. `payer` is
                // the relayer's published submitter, the only account the wrapper lets execute
                // this proof (`UnauthorizedCaller`).
                return {
                    kind: "withdraw",
                    payer: ctx.cfg.relayerAddress,
                    relayer: wrapper,
                    recipient: wrapper,
                    publicOut: out.gross,
                    intentHash: genericIntentHash(generic),
                    deadline,
                    submit: ({ payload: { proof, pubInputs, aux } }) => {
                        const payload: SubmitGenericPayload = {
                            chainId: ctx.cfg.chainId,
                            proof,
                            pubInputs,
                            aux,
                            generic,
                        };
                        return plan.submitGeneric(payload);
                    },
                };
            },
            // The outputs or the refund note appear asynchronously via the relayer's `flushBatch`.
            result: (_ctx, plan, landed): GenericCallResult => ({
                ...landedBase(landed, asset),
                outputCommitments: bound.outputs.map((o) => fieldToBytes32(o.cm)),
                outputCredits: plan.outputs.map((o) => o.value),
                refundCommitment: fieldToBytes32(bound.refund.cm),
                refundCredit: plan.refund.value,
                deadline: bound.deadline,
                spent: landed.spent,
                change: landed.change,
                protocolFee: out.fee,
                relayerFee: landed.relayerFee,
            }),
        },
        run,
    );
}

/** An output with its note value, flush fee and on-chain floor. */
interface SizedOutput {
    spec: GenericOutputSpec;
    value: CircuitAmount;
    fee: DepositFee;
    /** `Output.minOut`: at most what the calls return, and at most the note's pull. */
    minOut: bigint;
}

/**
 * The note for one output and the floor the wrapper holds the calls to.
 *
 * The wrapper requires `minOut <= returned` and `minOut <= pulled <= returned`. A `"floor"` output
 * keeps the caller's bound as `minOut`. An `"exact"` output is sized down from `tokens`, so its
 * pull may fall short of `tokens`; `minOut` is then the pull itself.
 */
function sizeOutput(
    op: string,
    index: number,
    spec: GenericOutputSpec,
    fee: DepositFee,
): SizedOutput {
    const { asset, tokens } = spec;
    const pricing = yieldPricing(asset);
    const value =
        spec.sizing === "floor"
            ? sizeBNote(tokens, asset.scale, asset.depositBps, fee.value, pricing)
            : sizeRefundNote(tokens, asset.scale, asset.depositBps, fee.value, pricing);
    if (value <= 0n) {
        throw new InvalidArgumentError(
            `${op}: output ${index} of ${tokens} is below one unit of its asset after fees (zero output note)`,
            { argument: "outputs" },
        );
    }
    const minOut =
        spec.sizing === "floor"
            ? tokens
            : depositTotal({
                  publicIn: value,
                  feeIn: fee.value,
                  depositBps: asset.depositBps,
                  scale: asset.scale,
                  yieldEnabled: pricing.yieldEnabled ?? false,
                  rate: pricing.rate,
              });
    return { spec, value: value as CircuitAmount, fee, minOut };
}

/** The limits `GenericCallWrapper._validateShape` and `_measuredTokens` enforce. */
function checkShape(args: GenericCallArgs): void {
    const { op, outputs, calls } = args;
    if (outputs.length === 0 || outputs.length > MAX_OUTPUTS) {
        throw new InvalidArgumentError(`${op}: between 1 and ${MAX_OUTPUTS} outputs are required`, {
            argument: "outputs",
        });
    }
    if (calls.length > MAX_CALLS) {
        throw new InvalidArgumentError(`${op}: at most ${MAX_CALLS} calls`, { argument: "calls" });
    }
    if (args.minGas <= 0n) {
        throw new InvalidArgumentError(`${op}: minGas must be positive`, { argument: "minGas" });
    }
    for (const [i, call] of calls.entries()) {
        if (!ADDRESS.test(call.target) || !HEX_BLOB.test(call.data) || call.value < 0n) {
            throw new InvalidArgumentError(`${op}: call ${i} is malformed`, { argument: "calls" });
        }
    }
    const tokens = new Set<string>();
    for (const [i, output] of outputs.entries()) {
        if (output.asset.yieldEnabled) {
            throw new InvalidArgumentError(`${op}: output ${i} is a yield asset`, {
                argument: "outputs",
            });
        }
        if (output.tokens <= 0n) {
            throw new InvalidArgumentError(`${op}: output ${i} must be positive`, {
                argument: "outputs",
            });
        }
        const token = output.asset.token.toLowerCase();
        if (tokens.has(token)) {
            throw new InvalidArgumentError(`${op}: two outputs share the token ${token}`, {
                argument: "outputs",
            });
        }
        tokens.add(token);
    }
    if (args.asset.yieldEnabled) {
        throw new InvalidArgumentError(`${op}: the input asset is a yield asset`, {
            argument: "asset",
        });
    }
}
