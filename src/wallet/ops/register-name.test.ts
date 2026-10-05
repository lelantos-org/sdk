// `executeRegisterName`: what is registered, who can be linked to it, and how the outcome is read.

import { decodeFunctionData, keccak256, pad, stringToBytes } from "viem";
import { describe, expect, it, vi } from "vitest";
import { ERC20_ABI, NAME_REGISTRAR_ABI } from "../../chain/viem/abi.js";
import { HANDLE_REGISTERED_TOPIC } from "../../chain/viem/name-calls.js";
import { assetId, evmAddress } from "../../core/brand.js";
import { UnsupportedOperationError } from "../../errors/chain.js";
import { InvalidArgumentError } from "../../errors/config.js";
import { decodeAddress } from "../../keys/address.js";
import { ownsAddress } from "../../keys/diversified.js";
import {
    deriveDiversifierKey,
    diversifierIndex,
    diversifierToBytes,
    PUBLISHED_DIVERSIFIER_INDEX,
} from "../../keys/diversifier.js";
import { deriveNameControllerKey } from "../../keys/name-controller.js";
import { depositTotal } from "../../protocol/fees.js";
import type { SubmitGenericPayload } from "../../protocol/transact.js";
import { makeTestCtx, NATIVE_ADAPTER_ADDR } from "../../test-utils/context.js";
import { estimateOf, freshAddress } from "../../test-utils/estimate.js";
import { storedNote } from "../../test-utils/wallet.js";
import type { AssetInfo } from "../assets/info.js";
import { REGISTER_NAME_MIN_GAS } from "../constants.js";
import { executeRegisterName } from "./register-name.js";

const USDC = assetId(1n);
const TOKEN = evmAddress(`0x${"a1".repeat(20)}`);
const WRAPPER = evmAddress(`0x${"cc".repeat(20)}`);
const REGISTRAR = evmAddress(`0x${"4e".repeat(20)}`);
const EOA = `0x${"33".repeat(20)}`;
const FEE = 5_000_000n;
const TX = `0x${"12".repeat(32)}`;

const asset = (over: Partial<AssetInfo> = {}) =>
    ({
        disabled: false,
        decimals: 6,
        ladder: [],
        id: USDC,
        token: TOKEN,
        scale: 1_000n,
        withdrawBps: 30n,
        depositBps: 20n,
        ...over,
    }) as AssetInfo;

interface Opts {
    fee?: bigint;
    available?: boolean;
    /** Topics of the registrar's log in the receipt; `null` for none, `"throw"` for no receipt. */
    receipt?: "registered" | "refunded" | "throw";
    asset?: Partial<AssetInfo>;
}

async function nameCtx(opts: Opts = {}) {
    const fee = opts.fee ?? FEE;
    let controller = "";
    const chain = {
        nativeAdapterAddress: () => NATIVE_ADAPTER_ADDR,
        // A signing chain layer: its account must never be named by a registration.
        payerAddress: async () => EOA,
        signPermit2: async () => {
            throw new Error("unused");
        },
        nameFee: vi.fn(async () => ({ token: TOKEN, amount: fee })),
        nameAvailable: vi.fn(async () => opts.available ?? true),
        txReceiptLogs: vi.fn(async () => {
            if (opts.receipt === "throw") throw new Error("no receipt");
            if (opts.receipt === "refunded") return [];
            return [
                {
                    address: REGISTRAR,
                    topics: [
                        HANDLE_REGISTERED_TOPIC,
                        keccak256(stringToBytes("mehow")),
                        pad(controller as `0x${string}`),
                    ],
                },
            ];
        }),
        maspAddress: async () => `0x${"99".repeat(20)}`,
    };
    const made = await makeTestCtx({
        notes: [storedNote("01", 100_000n, { asset: USDC })],
        estimate: estimateOf(await freshAddress(), { "1": 3n }),
        resolveAsset: async () => asset(opts.asset),
        chain,
        cfg: { genericCallWrapperAddress: WRAPPER, nameRegistrarAddress: REGISTRAR },
    });
    controller = deriveNameControllerKey(made.ctx.keys.nsk).address;
    const submitGeneric = vi.fn(async (_p: SubmitGenericPayload) => ({ txHash: TX }));
    Object.assign(made.ctx.cfg.submitter, { submitGeneric });
    return { ...made, submitGeneric, chain, controller };
}

describe("executeRegisterName", () => {
    it("approves the fee and registers the published address to the controller key", async () => {
        const { ctx, submitGeneric, controller } = await nameCtx();

        const res = await executeRegisterName(ctx, { label: "mehow" });

        const { generic } = submitGeneric.mock.calls[0]![0];
        expect(generic.calls).toHaveLength(2);
        const [approve, register] = generic.calls;
        expect(approve!.target).toBe(TOKEN);
        expect(approve!.value).toBe(0n);
        const approval = decodeFunctionData({
            abi: ERC20_ABI,
            data: approve!.data as `0x${string}`,
        });
        expect(approval.functionName).toBe("approve");
        expect(String(approval.args?.[0]).toLowerCase()).toBe(REGISTRAR);
        // Exactly the fee: a dearer registrar makes the call leg refund instead of paying more.
        expect(approval.args?.[1]).toBe(FEE);

        expect(register!.target).toBe(REGISTRAR);
        const call = decodeFunctionData({
            abi: NAME_REGISTRAR_ABI,
            data: register!.data as `0x${string}`,
        });
        expect(call.functionName).toBe("register");
        expect(call.args?.[0]).toBe("mehow");
        expect(call.args?.[1]).toBe(res.address);
        expect(call.args?.[2]).toBe(controller);

        expect(generic.minGas).toBe(REGISTER_NAME_MIN_GAS);
        expect(res).toMatchObject({
            kind: "registerName",
            label: "mehow",
            controller,
            registered: true,
            txHash: TX,
        });
        expect(res.registrationFee).toMatchObject({ asset: USDC, baseUnits: FEE });
        expect(Object.isFrozen(res)).toBe(true);
    });

    it("publishes the address at the published index, not the default one", async () => {
        const { ctx } = await nameCtx();
        const res = await executeRegisterName(ctx, { label: "mehow" });

        expect(res.address).not.toBe(ctx.address);
        const decoded = decodeAddress(ctx.J, res.address);
        expect(ownsAddress(ctx.P, ctx.J, ctx.keys.ivk, decoded)).toBe(true);
        const dvk = deriveDiversifierKey(ctx.keys.ivk);
        expect(diversifierIndex(dvk, diversifierToBytes(decoded.d))).toBe(
            PUBLISHED_DIVERSIFIER_INDEX,
        );
    });

    it("names the controller, never the wallet's EVM account, as every public receiver", async () => {
        const { ctx, submitGeneric, controller } = await nameCtx();
        await executeRegisterName(ctx, { label: "mehow" });

        const payload = submitGeneric.mock.calls[0]![0];
        expect(payload.generic.refundTo).toBe(controller);
        expect(payload.generic.surplusTo).toBe(controller);
        const wire = JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        expect(wire.toLowerCase()).not.toContain(EOA.slice(2));
    });

    it("unshields the fee plus the smallest change the pool re-shields", async () => {
        const { ctx, submitGeneric } = await nameCtx();
        const res = await executeRegisterName(ctx, { label: "mehow" });

        const { generic } = submitGeneric.mock.calls[0]![0];
        const info = asset();
        const smallest = depositTotal({
            publicIn: 1n,
            feeIn: 3n,
            depositBps: info.depositBps,
            scale: info.scale,
        });
        // Leg 1 nets at least the fee and the one-unit change, and no more than a unit above it.
        expect(generic.amountIn).toBeGreaterThanOrEqual(FEE + smallest);
        expect(generic.amountIn).toBeLessThan(FEE + smallest + 2n * info.scale);
        // One output: the change, in the fee token's asset, to the wallet's own address.
        expect(generic.outputs).toHaveLength(1);
        const change = generic.outputs[0]!;
        expect(change.deposit.publicAssetId).toBe(USDC);
        expect(change.minOut).toBeLessThanOrEqual(generic.amountIn - FEE);
        expect(res.changeCredit.amount).toBe(change.deposit.publicIn);
        expect(res.changeCredit.amount).toBeGreaterThanOrEqual(1n);
        expect(res.changeCommitment).not.toBe(res.refundCommitment);
    });

    it("folds the label's case and refuses a malformed or dotted one before any read", async () => {
        const { ctx, submitGeneric, chain } = await nameCtx();
        const res = await executeRegisterName(ctx, { label: "  MeHow " });
        expect(res.label).toBe("mehow");

        chain.nameAvailable.mockClear();
        for (const label of ["ab", "a--b", "-mehow", "mehow.lelantos.xyz", ""]) {
            await expect(executeRegisterName(ctx, { label }), label).rejects.toBeInstanceOf(
                InvalidArgumentError,
            );
        }
        expect(chain.nameAvailable).not.toHaveBeenCalled();
        expect(submitGeneric).toHaveBeenCalledTimes(1);
    });

    it("refuses a taken label before proving", async () => {
        const { ctx, submitGeneric, witness } = await nameCtx({ available: false });
        await expect(executeRegisterName(ctx, { label: "mehow" })).rejects.toMatchObject({
            argument: "label",
            details: { reason: "taken" },
        });
        expect(witness.last).toBeUndefined();
        expect(submitGeneric).not.toHaveBeenCalled();
    });

    it("reports a refunded execution as not registered", async () => {
        const { ctx } = await nameCtx({ receipt: "refunded" });
        const res = await executeRegisterName(ctx, { label: "mehow" });
        expect(res.registered).toBe(false);
    });

    it("leaves the outcome undecided when the receipt cannot be read", async () => {
        const { ctx } = await nameCtx({ receipt: "throw" });
        const res = await executeRegisterName(ctx, { label: "mehow" });
        expect(res.registered).toBeUndefined();
    });

    it("registers without an approval where registration is free, given an asset", async () => {
        const { ctx, submitGeneric } = await nameCtx({ fee: 0n });
        await expect(executeRegisterName(ctx, { label: "mehow" })).rejects.toMatchObject({
            argument: "asset",
        });

        const res = await executeRegisterName(ctx, { label: "mehow", asset: USDC });
        const { generic } = submitGeneric.mock.calls[0]![0];
        expect(generic.calls).toHaveLength(1);
        expect(generic.calls[0]!.target).toBe(REGISTRAR);
        expect(res.registrationFee).toBeNull();
    });

    it("asks for the asset when the fee token cannot be mapped to one", async () => {
        const { ctx, submitGeneric } = await nameCtx();
        const resolve = ctx.assets.resolveVerified;
        (ctx.assets as { resolveVerified: unknown }).resolveVerified = async (ref: unknown) => {
            if (typeof ref === "string" && ref.startsWith("0x")) {
                throw new InvalidArgumentError("no registered asset for token", {
                    argument: "asset",
                });
            }
            return resolve(ref as never);
        };
        await expect(executeRegisterName(ctx, { label: "mehow" })).rejects.toMatchObject({
            argument: "asset",
            message: expect.stringContaining("pass `asset`"),
        });
        expect(submitGeneric).not.toHaveBeenCalled();

        // Named by id, it needs no list.
        const res = await executeRegisterName(ctx, { label: "mehow", asset: USDC });
        expect(res.registered).toBe(true);
    });

    it("refuses an asset that is not the fee token's, or that earns yield", async () => {
        const other = await nameCtx({ asset: { token: evmAddress(`0x${"b2".repeat(20)}`) } });
        await expect(executeRegisterName(other.ctx, { label: "mehow" })).rejects.toMatchObject({
            argument: "asset",
        });
        const yielding = await nameCtx({
            asset: { yieldEnabled: true, rate: { gross: 1_000n, supply: 1n } },
        });
        await expect(executeRegisterName(yielding.ctx, { label: "mehow" })).rejects.toMatchObject({
            argument: "asset",
        });
    });

    it("needs a registrar address and a chain layer that reads it", async () => {
        const { ctx } = await nameCtx();
        delete (ctx.cfg as { nameRegistrarAddress?: string }).nameRegistrarAddress;
        await expect(executeRegisterName(ctx, { label: "mehow" })).rejects.toBeInstanceOf(
            UnsupportedOperationError,
        );

        const plain = await makeTestCtx({ cfg: { nameRegistrarAddress: REGISTRAR } });
        await expect(executeRegisterName(plain.ctx, { label: "mehow" })).rejects.toBeInstanceOf(
            UnsupportedOperationError,
        );
    });
});
