// `executeGenericCall`: what reaches the relayer is what the withdraw proof binds, and each note is
// sized inside the bounds `GenericCallWrapper` holds its pull to.

import { describe, expect, it, vi } from "vitest";
import { assetId, evmAddress, type TokenAmount } from "../../core/brand.js";
import { UnsupportedOperationError } from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { DeadlinePassedError } from "../../errors/spend.js";
import type { OutputAux } from "../../notes/aux.js";
import { genericIntentHash } from "../../protocol/abi-hash.js";
import { depositTotal } from "../../protocol/fees.js";
import type { SubmitGenericPayload } from "../../protocol/transact.js";
import { makeTestCtx } from "../../test-utils/context.js";
import { estimateOf, freshAddress } from "../../test-utils/estimate.js";
import { openOutput } from "../../test-utils/outputs.js";
import { storedNote } from "../../test-utils/wallet.js";
import { resolveOutAmount } from "../assets/amount.js";
import type { AssetInfo } from "../assets/info.js";
import { executeGenericCall, type GenericCallArgs } from "./generic-call.js";
import { detachedRun } from "./run-spend.js";

const IN = assetId(1n); // scale 10, 30 bps withdraw, 20 bps deposit
const OUT = assetId(2n); // scale 1000, 20 bps deposit
const WRAPPER = evmAddress(`0x${"cc".repeat(20)}`);
const REFUND = evmAddress(`0x${"ee".repeat(20)}`);
const SURPLUS = evmAddress(`0x${"dd".repeat(20)}`);
const TARGET = `0x${"7a".repeat(20)}`;

const ASSETS: Record<string, Partial<AssetInfo>> = {
    "1": {
        id: IN,
        token: evmAddress(`0x${"a1".repeat(20)}`),
        scale: 10n,
        withdrawBps: 30n,
        depositBps: 20n,
    },
    "2": {
        id: OUT,
        token: evmAddress(`0x${"b2".repeat(20)}`),
        scale: 1_000n,
        withdrawBps: 0n,
        depositBps: 20n,
    },
};

const asset = (id: bigint) =>
    ({ disabled: false, decimals: 6, ladder: [], ...ASSETS[String(id)] }) as AssetInfo;

async function genericCtx() {
    const estimate = vi.fn(async () => estimateOf(await freshAddress(), { "1": 3n, "2": 2n }));
    const made = await makeTestCtx({
        notes: [storedNote("01", 100_000n, { asset: IN })],
        resolveAsset: async (ref) => asset(BigInt(ref as bigint)),
        cfg: { genericCallWrapperAddress: WRAPPER },
    });
    const submitGeneric = vi.fn(async (_p: SubmitGenericPayload) => ({
        txHash: `0x${"12".repeat(32)}`,
    }));
    Object.assign(made.ctx.cfg.submitter, { submitGeneric, estimate });
    return { ...made, submitGeneric, estimate };
}

/** A round trip: no calls, the whole input returned and re-shielded. */
function roundTrip(ctx: Awaited<ReturnType<typeof genericCtx>>["ctx"]): GenericCallArgs {
    const input = asset(IN);
    const out = resolveOutAmount({ net: { baseUnits: 10_000n } }, input, "generic");
    return {
        op: "generic",
        asset: input,
        out,
        calls: [],
        outputs: [{ asset: input, tokens: out.net, sizing: "exact", recipient: ctx.ownAddress }],
        minGas: 100_000n,
        refundTo: REFUND,
    };
}

const pullOf = (info: AssetInfo, publicIn: bigint, feeIn: bigint) =>
    depositTotal({ publicIn, feeIn, depositBps: info.depositBps, scale: info.scale });

describe("executeGenericCall", () => {
    it("submits the intent the withdraw proof binds", async () => {
        const { ctx, submitGeneric, estimate } = await genericCtx();
        const args = roundTrip(ctx);

        const res = await executeGenericCall(ctx, args, {}, detachedRun("generic"));

        const { generic, pubInputs, chainId } = submitGeneric.mock.calls[0]![0];
        expect(chainId).toBe(31337n);
        expect(pubInputs.recipient).toBe(WRAPPER);
        expect(pubInputs.relayer).toBe(WRAPPER);
        expect(pubInputs.payer).toBe(ctx.cfg.relayerAddress);
        expect(pubInputs.publicOut).toBe(args.out.gross);
        expect(pubInputs.intentHash).toBe(genericIntentHash(generic));
        expect(generic.amountIn).toBe(args.out.net);
        expect(generic.minGas).toBe(100_000n);
        expect(generic.refundTo).toBe(REFUND);
        // Unset, `surplusTo` follows `refundTo`.
        expect(generic.surplusTo).toBe(REFUND);
        expect(generic.calls).toEqual([]);
        // Every escrow is pulled from the wrapper.
        for (const d of [generic.outputs[0]!.deposit, generic.refundD]) {
            expect(d.payer).toBe(WRAPPER);
            expect(d.recipient).toBe(WRAPPER);
        }
        expect(res.deadline).toBe(generic.deadline);
        expect(res.outputCommitments).toHaveLength(1);
        expect(res.outputCommitments[0]).not.toBe(res.refundCommitment);
        // The relayer is quoted for the gas the call leg is forwarded.
        expect(estimate).toHaveBeenCalledWith(31337n, "generic", { minGas: 100_000n });
    });

    it("sizes an exact output to the largest note whose pull fits, and floors at that pull", async () => {
        const { ctx, submitGeneric } = await genericCtx();
        const args = roundTrip(ctx);

        const res = await executeGenericCall(ctx, args, {}, detachedRun("generic"));

        const output = submitGeneric.mock.calls[0]![0].generic.outputs[0]!;
        const info = asset(IN);
        const { publicIn, feeIn } = output.deposit;
        expect(publicIn).toBe(res.outputCredits[0]);
        expect(feeIn).toBe(3n);
        expect(pullOf(info, publicIn, feeIn)).toBeLessThanOrEqual(args.out.net);
        expect(pullOf(info, publicIn + 1n, feeIn)).toBeGreaterThan(args.out.net);
        // The wrapper requires `minOut <= pulled`, so the floor is the pull, not `tokens`.
        expect(output.minOut).toBe(pullOf(info, publicIn, feeIn));
    });

    it("sizes a floor output to the smallest note whose pull covers the floor", async () => {
        const { ctx, submitGeneric } = await genericCtx();
        const out = asset(OUT);
        const floor = 5_000_000n as TokenAmount;
        const args: GenericCallArgs = {
            ...roundTrip(ctx),
            calls: [{ target: TARGET, value: 0n, data: "0xaabbccdd" }],
            outputs: [{ asset: out, tokens: floor, sizing: "floor", recipient: ctx.ownAddress }],
            surplusTo: SURPLUS,
        };

        await executeGenericCall(ctx, args, {}, detachedRun("generic"));

        const { generic } = submitGeneric.mock.calls[0]![0];
        const { publicIn, feeIn, publicAssetId } = generic.outputs[0]!.deposit;
        expect(publicAssetId).toBe(OUT);
        expect(generic.outputs[0]!.minOut).toBe(floor);
        expect(pullOf(out, publicIn, feeIn)).toBeGreaterThanOrEqual(floor);
        expect(pullOf(out, publicIn - 1n, feeIn)).toBeLessThan(floor);
        expect(generic.surplusTo).toBe(SURPLUS);
        expect(generic.calls).toEqual(args.calls);
    });

    it("addresses the outputs and the refund to the wallet and their fee leaves to the relayer", async () => {
        const { ctx, submitGeneric } = await genericCtx();

        await executeGenericCall(ctx, roundTrip(ctx), {}, detachedRun("generic"));

        const { generic } = submitGeneric.mock.calls[0]![0];
        const opens = (aux: OutputAux) => openOutput(ctx.J, ctx.keys.ivk, aux) !== null;
        expect([generic.outputs[0]!.aux, generic.refundAuxD].map(opens)).toEqual([true, true]);
        expect([generic.outputs[0]!.feeAux, generic.refundFeeAuxD].map(opens)).toEqual([
            false,
            false,
        ]);
    });

    it("refuses shapes the wrapper would revert on, before quoting or proving", async () => {
        const { ctx, submitGeneric, estimate, witness } = await genericCtx();
        const base = roundTrip(ctx);
        const output = base.outputs[0]!;
        const bad: Partial<GenericCallArgs>[] = [
            { outputs: [] },
            { outputs: [output, output] },
            { outputs: Array.from({ length: 5 }, () => output) },
            { outputs: [{ ...output, tokens: 0n as TokenAmount }] },
            {
                calls: Array.from({ length: 17 }, () => ({
                    target: TARGET,
                    value: 0n,
                    data: "0x",
                })),
            },
            { calls: [{ target: "0x1234", value: 0n, data: "0x" }] },
            { calls: [{ target: TARGET, value: 0n, data: "0xabc" }] },
            { minGas: 0n },
        ];
        for (const over of bad) {
            await expect(
                executeGenericCall(ctx, { ...base, ...over }, {}, detachedRun("generic")),
            ).rejects.toBeInstanceOf(InvalidArgumentError);
        }
        expect(estimate).not.toHaveBeenCalled();
        expect(witness.last).toBeUndefined();
        expect(submitGeneric).not.toHaveBeenCalled();
    });

    it("refuses a receiver the wrapper cannot pay", async () => {
        const { ctx } = await genericCtx();
        for (const over of [{ refundTo: WRAPPER }, { surplusTo: ctx.cfg.relayerAddress }]) {
            await expect(
                executeGenericCall(ctx, { ...roundTrip(ctx), ...over }, {}, detachedRun("generic")),
            ).rejects.toBeInstanceOf(InvalidArgumentError);
        }
    });

    it("refuses a deadline already passed", async () => {
        const { ctx, submitGeneric } = await genericCtx();
        await expect(
            executeGenericCall(
                ctx,
                { ...roundTrip(ctx), deadline: 1n },
                {},
                detachedRun("generic"),
            ),
        ).rejects.toBeInstanceOf(DeadlinePassedError);
        expect(submitGeneric).not.toHaveBeenCalled();
    });

    it("needs a submitter that relays generic executions and a wrapper address", async () => {
        const plain = await makeTestCtx({ notes: [storedNote("01", 100_000n, { asset: IN })] });
        await expect(
            executeGenericCall(plain.ctx, roundTrip(plain.ctx), {}, detachedRun("generic")),
        ).rejects.toBeInstanceOf(UnsupportedOperationError);

        const { ctx } = await genericCtx();
        delete (ctx.cfg as { genericCallWrapperAddress?: string }).genericCallWrapperAddress;
        await expect(
            executeGenericCall(ctx, roundTrip(ctx), {}, detachedRun("generic")),
        ).rejects.toBeInstanceOf(UnsupportedOperationError);
    });
});
