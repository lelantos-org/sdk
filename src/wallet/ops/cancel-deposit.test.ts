// `cancelDeposit`: by the escrow a deposit returned, or by id with the inputs rebuilt
// from the pool's `DepositEscrowed` log; native escrows through `NativeAdapter`.

import { describe, expect, it, vi } from "vitest";
import type { CancelDepositInputs, DepositEscrowedRecord } from "../../chain/types.js";
import { assetId, branded, evmAddress, type Hex32 } from "../../core/brand.js";
import { makeTestCtx, NATIVE_ADAPTER_ADDR } from "../../test-utils/context.js";
import type { AssetInfo } from "../assets/info.js";
import type { DepositPhase } from "../types/options.js";
import type { DepositEscrow } from "../types/results.js";
import { executeCancelDeposit } from "./cancel-deposit.js";

const USDC = assetId(1n);
const WETH = assetId(2n);
const PAYER = evmAddress(`0x${"aa".repeat(20)}`);
const TX = branded<Hex32>(`0x${"cc".repeat(32)}`);

const record = (over: Partial<DepositEscrowedRecord> = {}): DepositEscrowedRecord => ({
    id: 5n,
    payer: PAYER,
    recipient: PAYER,
    publicAssetId: USDC,
    publicIn: 1_000n,
    feeBpsAtSubmit: 20,
    cm: branded<Hex32>(`0x${"01".repeat(32)}`),
    cvDep: [1n, 2n],
    rcv: 3n,
    feeIn: 7n,
    feeAssetId: WETH,
    feeCm: branded<Hex32>(`0x${"02".repeat(32)}`),
    feeCvDep: [4n, 5n],
    submittedAt: 900,
    ...over,
});

const inputsOf = ({ id: _, recipient: __, rcv: ___, ...rest }: DepositEscrowedRecord) =>
    rest as CancelDepositInputs;

async function harness(opts: { record?: DepositEscrowedRecord | null; pending?: boolean } = {}) {
    const rec = opts.record === undefined ? record() : opts.record;
    const chain = {
        payerAddress: async () => PAYER,
        signPermit2: async () => ({}),
        nativeAdapterAddress: () => NATIVE_ADAPTER_ADDR,
        blockNumber: async () => 20_000,
        cancelDelay: async () => 7_200,
        getEscrowed: vi.fn(async () => (opts.pending === false ? null : { digest: TX })),
        fetchDepositEscrowed: vi.fn(async () => rec),
        cancelDeposit: vi.fn(async () => ({
            txHash: TX,
            refunded: 10_020n,
            feeAssetId: WETH,
            feeRefunded: 7_000n,
        })),
        cancelDepositNative: vi.fn(async () => ({
            txHash: TX,
            refunded: 17_020n,
            feeAssetId: WETH,
            feeRefunded: 0n,
        })),
    };
    const made = await makeTestCtx({
        chain,
        resolveAsset: async (ref) =>
            ({
                id: BigInt(ref as bigint),
                token: evmAddress(`0x${"0b".repeat(20)}`),
                scale: BigInt(ref as bigint) === 1n ? 10n : 1_000n,
                disabled: false,
                decimals: 6,
            }) as Partial<AssetInfo>,
    });
    const phases: DepositPhase[] = [];
    const run = { opId: "c1", op: "cancelDeposit", phase: (p: DepositPhase) => phases.push(p) };
    return { ...made, chain, phases, run };
}

describe("cancelDeposit", () => {
    it("cancels the escrow a deposit returned with its own inputs", async () => {
        const { ctx, chain, run, phases } = await harness();
        const escrow: DepositEscrow = {
            depositId: 5n,
            native: false,
            asset: USDC,
            commitment: record().cm,
            cancelInputs: inputsOf(record()),
            cancellableAtBlock: 8_100,
        };
        const res = await executeCancelDeposit(ctx, structuredClone(escrow), run);

        expect(chain.fetchDepositEscrowed).not.toHaveBeenCalled();
        expect(chain.cancelDeposit).toHaveBeenCalledWith(5n, escrow.cancelInputs);
        expect(res).toEqual({
            kind: "cancelDeposit",
            opId: "c1",
            txHash: TX,
            depositId: 5n,
            native: false,
            refunded: { asset: USDC, amount: 1_002n, baseUnits: 10_020n },
            feeRefunded: { asset: WETH, amount: 7n, baseUnits: 7_000n },
        });
        expect(phases).toEqual(["preparing", "submitting", "confirmed"]);
    });

    it("rebuilds the inputs from the DepositEscrowed log when given only the id", async () => {
        const { ctx, chain, run } = await harness();
        const res = await executeCancelDeposit(ctx, { depositId: 5n }, run);
        // Far enough back for an escrow that is already cancellable: tip − delay − margin.
        expect(chain.fetchDepositEscrowed).toHaveBeenCalledWith(5n, 20_000n - 7_200n - 3_600n);
        expect(chain.cancelDeposit).toHaveBeenCalledWith(5n, inputsOf(record()));
        expect(res.native).toBe(false);
    });

    it("honours an explicit fromBlock", async () => {
        const { ctx, chain, run } = await harness();
        await executeCancelDeposit(ctx, { depositId: 5n, fromBlock: 12n }, run);
        expect(chain.fetchDepositEscrowed).toHaveBeenCalledWith(5n, 12n);
    });

    it("routes an adapter-owned escrow through cancelDepositNative, without a payer", async () => {
        const native = record({
            payer: evmAddress(NATIVE_ADAPTER_ADDR),
            feeIn: 0n,
            feeAssetId: assetId(0n),
        });
        const { ctx, chain, run } = await harness({ record: native });
        const res = await executeCancelDeposit(ctx, { depositId: 5n }, run);

        expect(chain.cancelDeposit).not.toHaveBeenCalled();
        const [id, inputs] = chain.cancelDepositNative.mock.calls[0]! as unknown as [
            bigint,
            Record<string, unknown>,
        ];
        expect(id).toBe(5n);
        expect(inputs).not.toHaveProperty("payer");
        expect(res).toMatchObject({ native: true, feeRefunded: null });
    });

    it("refuses an id with no log, and an escrow no longer pending, without sending", async () => {
        const missing = await harness({ record: null });
        await expect(
            executeCancelDeposit(missing.ctx, { depositId: 5n }, missing.run),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "depositId" });

        const flushed = await harness({ pending: false });
        await expect(
            executeCancelDeposit(flushed.ctx, { depositId: 5n }, flushed.run),
        ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", argument: "depositId" });
        expect(flushed.chain.cancelDeposit).not.toHaveBeenCalled();
    });

    it("refuses malformed targets before any read", async () => {
        const { ctx, chain, run } = await harness();
        await expect(
            executeCancelDeposit(ctx, { depositId: 5 } as never, run),
        ).rejects.toMatchObject({ argument: "depositId" });
        await expect(
            executeCancelDeposit(
                ctx,
                { depositId: 5n, cancelInputs: { publicIn: 1 } } as never,
                run,
            ),
        ).rejects.toMatchObject({ argument: "cancelInputs" });
        expect(chain.getEscrowed).not.toHaveBeenCalled();
    });

    it("needs a signing chain layer, and the log reader for a bare id", async () => {
        const { ctx, run } = await harness();
        const noSigner = { ...ctx, cfg: { ...ctx.cfg, chain: { fetchAsset: async () => ({}) } } };
        await expect(
            executeCancelDeposit(noSigner as never, { depositId: 5n }, run),
        ).rejects.toMatchObject({ code: "NO_EVM_ACCOUNT", operation: "cancelDeposit" });

        const chain = { ...(ctx.cfg.chain as object), fetchDepositEscrowed: undefined };
        const noReader = { ...ctx, cfg: { ...ctx.cfg, chain } };
        await expect(
            executeCancelDeposit(noReader as never, { depositId: 5n }, run),
        ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    });
});
