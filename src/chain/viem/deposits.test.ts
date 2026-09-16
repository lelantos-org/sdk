import { decodeFunctionData, encodeAbiParameters, encodeEventTopics } from "viem";
import { describe, expect, it } from "vitest";
import { assetId, branded, type EvmAddress, type Hex32 } from "../../core/brand.js";
import { TxMiningError, TxRevertedError } from "../../errors/chain.js";
import { WalletConfigError } from "../../errors/config.js";
import type { EthSigner } from "../../keys/signer.js";
import type { AuxOutput, DepositRequest, Permit2Sig } from "../../protocol/deposit-request.js";
import type { CancelDepositInputs } from "../types.js";
import { MASP_ABI, NATIVE_ADAPTER_ABI } from "./abi.js";
import type { ViemCtx } from "./ctx.js";
import {
    cancelDeposit,
    cancelDepositNative,
    submitDeposit,
    submitDepositAuthorized,
    submitDepositNative,
} from "./deposits.js";

// A wrong target contract or encoded function fails silently: calldata built
// against a stale pool ABI is well-formed and reverts on-chain, as does a
// native deposit aimed at the pool.

const MASP = branded<EvmAddress>("0x0000000000000000000000000000000000000a11");
const ADAPTER = branded<EvmAddress>("0x00000000000000000000000000000000000ada9e");
const PERMIT2 = branded<EvmAddress>("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const TX = branded<Hex32>(`0x${"11".repeat(32)}`);

interface Sent {
    to: EvmAddress;
    data?: `0x${string}` | undefined;
    value?: bigint | undefined;
}

/**
 * Records the transaction and reports a receipt with no logs, which makes the
 * id extraction throw. The assertions here are about what was *sent*; the
 * `DepositEscrowed` decode is a separate concern.
 */
function stubCtx(
    nativeAdapterAddress?: EvmAddress,
    logs: readonly unknown[] = [],
    receipt: { status?: string; blockNumber?: bigint; l1BlockNumber?: `0x${string}` } = {},
): { ctx: ViemCtx; sent: Sent[] } {
    const sent: Sent[] = [];
    const signer = {
        chainId: 31337n,
        getAddress: async () => MASP,
        signTypedData: async () => "0x",
        sendTransaction: async (args: Sent) => {
            sent.push(args);
            return TX;
        },
    } as unknown as EthSigner;
    const ctx = {
        publicClient: {
            waitForTransactionReceipt: async () => ({
                logs,
                status: receipt.status ?? "success",
                blockNumber: receipt.blockNumber ?? 1n,
            }),
            request: async () =>
                receipt.l1BlockNumber ? { l1BlockNumber: receipt.l1BlockNumber } : {},
        },
        signer,
        maspAddress: MASP,
        permit2Address: PERMIT2,
        nativeAdapterAddress,
        chainId: async () => 31337n,
    } as unknown as ViemCtx;
    return { ctx, sent };
}

const request = (payer: EvmAddress): DepositRequest => ({
    chainId: 31337n,
    publicAssetId: 1n,
    publicIn: 250n,
    payer,
    recipient: "0x000000000000000000000000000000000000beef",
    outCm: `0x${"22".repeat(32)}`,
    cvDep: [23n, 24n],
    rcv: 27n,
    // A relayer note in another asset: the field most likely to be dropped.
    feeAssetId: 2n,
    feeIn: 5n,
    feeCm: `0x${"44".repeat(32)}`,
    feeCvDep: [25n, 26n],
    feeRcv: 28n,
});

const aux: AuxOutput = {
    clueRx: 1n,
    clueRy: 2n,
    ephPubX: 3n,
    ephPubY: 4n,
    ciphertext: new Uint8Array([0, 0, 0xde, 0xad]),
};

const permit2: Permit2Sig = {
    nonce: 1n,
    deadline: 2n,
    maxTotal: 3n,
    maxFee: 4n,
    signature: `0x${"33".repeat(65)}`,
};

/** The tail always throws on an empty log set; the send already happened. */
async function capture(run: Promise<unknown>, sent: Sent[]): Promise<Sent> {
    await expect(run).rejects.toBeInstanceOf(TxMiningError);
    expect(sent).toHaveLength(1);
    return sent[0]!;
}

describe("deposit submission", () => {
    it("sends the Permit2-witness deposit to the pool as `deposit`", async () => {
        const { ctx, sent } = stubCtx();
        const tx = await capture(
            submitDeposit(ctx, { deposit: request(MASP), aux, feeAux: aux, permit2 }),
            sent,
        );

        expect(tx.to).toBe(MASP);
        expect(tx.value).toBeUndefined();
        const call = decodeFunctionData({ abi: MASP_ABI, data: tx.data! });
        expect(call.functionName).toBe("deposit");
        // Both ceilings and the fee asset reach the pool: a dropped `maxFee`
        // reverts the two-token pull, a dropped `feeAssetId` the digest.
        const [d, sig] = call.args as readonly unknown[];
        expect(d).toMatchObject({
            feeAssetId: 2n,
            feeIn: 5n,
            feeCm: request(MASP).feeCm,
            feeCvDep: [25n, 26n],
            feeRcv: 28n,
        });
        expect(sig).toEqual(permit2);
    });

    it("sends the allowance deposit to the pool as `depositAuthorized`", async () => {
        const { ctx, sent } = stubCtx();
        const tx = await capture(
            submitDepositAuthorized(ctx, { deposit: request(MASP), aux, feeAux: aux }),
            sent,
        );

        expect(tx.to).toBe(MASP);
        expect(decodeFunctionData({ abi: MASP_ABI, data: tx.data! }).functionName).toBe(
            "depositAuthorized",
        );
    });

    /// The pool holds no native coin, so the native deposit targets the adapter.
    it("sends the native deposit to the adapter, with the value attached", async () => {
        const { ctx, sent } = stubCtx(ADAPTER);
        const tx = await capture(
            submitDepositNative(ctx, {
                deposit: request(ADAPTER),
                aux,
                feeAux: aux,
                value: 1_000n,
            }),
            sent,
        );

        expect(tx.to).toBe(ADAPTER);
        expect(tx.to).not.toBe(MASP);
        expect(tx.value).toBe(1_000n);
        const call = decodeFunctionData({ abi: NATIVE_ADAPTER_ABI, data: tx.data! });
        expect(call.functionName).toBe("depositNative");
        // The payer must be the adapter or the call reverts `AdapterNotPayer`:
        // the adapter wraps the coin, so the pool pulls against its allowance,
        // not the sender's. viem checksums decoded addresses, so compare
        // case-insensitively.
        const payer = (call.args as readonly unknown[] as readonly [{ payer: string }])[0].payer;
        expect(payer.toLowerCase()).toBe(ADAPTER.toLowerCase());
    });

    it("refuses a native deposit when no adapter is configured", async () => {
        const { ctx, sent } = stubCtx();
        await expect(
            submitDepositNative(ctx, {
                deposit: request(ADAPTER),
                aux,
                feeAux: aux,
                value: 1_000n,
            }),
        ).rejects.toBeInstanceOf(WalletConfigError);
        expect(sent, "nothing should be broadcast").toHaveLength(0);
    });
});

// A cancel resupplies the digest preimage, `FeeNote.feeAssetId` included, and
// reads the refund split back off the pool's `DepositCanceled` log.
describe("deposit cancellation", () => {
    const inputs: CancelDepositInputs = {
        publicIn: 250n,
        cm: branded<Hex32>(`0x${"22".repeat(32)}`),
        cvDep: [23n, 24n],
        publicAssetId: assetId(1n),
        feeBpsAtSubmit: 30,
        payer: branded<EvmAddress>("0x000000000000000000000000000000000000beef"),
        submittedAt: 100,
        feeIn: 5n,
        feeAssetId: assetId(2n),
        feeCm: branded<Hex32>(`0x${"44".repeat(32)}`),
        feeCvDep: [25n, 26n],
    };

    /** A `DepositCanceled` log as the pool emits it. */
    const canceledLog = (
        address: EvmAddress,
        id: bigint,
        refunded: bigint,
        feeAssetId: bigint,
        feeRefunded: bigint,
    ) => ({
        address,
        topics: encodeEventTopics({
            abi: MASP_ABI,
            eventName: "DepositCanceled",
            args: { id, payer: inputs.payer },
        }),
        data: encodeAbiParameters(
            [{ type: "uint256" }, { type: "uint64" }, { type: "uint256" }],
            [refunded, feeAssetId, feeRefunded],
        ),
        blockNumber: 1n,
        logIndex: 0,
        transactionHash: TX,
        transactionIndex: 0,
        blockHash: TX,
        removed: false,
    });

    it("encodes the fee note with its asset and returns both refunds", async () => {
        const { ctx, sent } = stubCtx(undefined, [canceledLog(MASP, 9n, 2_500n, 2n, 50n)]);
        const out = await cancelDeposit(ctx, 9n, inputs);

        expect(sent).toHaveLength(1);
        const call = decodeFunctionData({ abi: MASP_ABI, data: sent[0]!.data! });
        expect(call.functionName).toBe("cancelDeposit");
        expect((call.args as readonly unknown[])[8]).toEqual({
            feeIn: 5,
            feeAssetId: 2n,
            feeCm: inputs.feeCm,
            feeCvDep: [25n, 26n],
        });
        expect(out).toEqual({ txHash: TX, refunded: 2_500n, feeAssetId: 2n, feeRefunded: 50n });
    });

    it("reads the pool's log on the native path, ignoring other ids", async () => {
        const { ctx, sent } = stubCtx(ADAPTER, [
            canceledLog(MASP, 8n, 1n, 0n, 0n),
            canceledLog(MASP, 9n, 2_550n, 1n, 0n),
        ]);
        const { payer: _, ...native } = inputs;
        const out = await cancelDepositNative(ctx, 9n, { ...native, feeAssetId: assetId(1n) });

        expect(sent[0]!.to).toBe(ADAPTER);
        const call = decodeFunctionData({ abi: NATIVE_ADAPTER_ABI, data: sent[0]!.data! });
        expect(call.functionName).toBe("cancelNative");
        expect(((call.args as readonly unknown[])[7] as { feeAssetId: bigint }).feeAssetId).toBe(
            1n,
        );
        expect(out.refunded).toBe(2_550n);
        expect(out.feeRefunded).toBe(0n);
    });

    it("refuses a receipt with no DepositCanceled log from the pool", async () => {
        // Emitted at another address, so it is not the pool's.
        const { ctx } = stubCtx(undefined, [canceledLog(ADAPTER, 9n, 1n, 0n, 0n)]);
        await expect(cancelDeposit(ctx, 9n, inputs)).rejects.toBeInstanceOf(TxMiningError);
    });
});

// A mined deposit reports the escrow straight off its receipt, so a caller can cancel it later
// without a log query.
describe("deposit receipt", () => {
    const event = MASP_ABI.find(
        (a) => a.type === "event" && a.name === "DepositEscrowed",
    ) as Extract<(typeof MASP_ABI)[number], { type: "event"; name: "DepositEscrowed" }>;

    /** The pool's `DepositEscrowed` for `request(payer)`, as a receipt log at `address`. */
    const escrowedLog = (address: EvmAddress, id: bigint, payer: EvmAddress) => {
        const d = request(payer);
        const values: Record<string, unknown> = {
            publicAssetId: d.publicAssetId,
            publicIn: d.publicIn,
            feeBpsAtSubmit: 20,
            cm: d.outCm,
            cvDepX: d.cvDep[0],
            cvDepY: d.cvDep[1],
            rcv: d.rcv,
            clueRx: 0n,
            clueRy: 0n,
            ephPubX: 0n,
            ephPubY: 0n,
            ciphertext: "0x",
            feeAssetId: d.feeAssetId,
            feeIn: d.feeIn,
            feeCm: d.feeCm,
            feeCvDepX: d.feeCvDep[0],
            feeCvDepY: d.feeCvDep[1],
            feeRcv: d.feeRcv,
            feeClueRx: 0n,
            feeClueRy: 0n,
            feeEphPubX: 0n,
            feeEphPubY: 0n,
            feeCiphertext: "0x",
        };
        const data = event.inputs.filter((i) => !("indexed" in i && i.indexed));
        return {
            address,
            topics: encodeEventTopics({
                abi: MASP_ABI,
                eventName: "DepositEscrowed",
                args: { id, payer, recipient: d.recipient as EvmAddress },
            }),
            data: encodeAbiParameters(data, data.map((i) => values[i.name as string]) as never),
            blockNumber: 77n,
            logIndex: 0,
            transactionHash: TX,
            transactionIndex: 0,
            blockHash: TX,
            removed: false,
        };
    };

    it("returns the block and the escrow payload, submittedAt as the EVM saw it", async () => {
        // Another contract's look-alike log is ignored; the pool's is decoded.
        const logs = [escrowedLog(ADAPTER, 1n, MASP), escrowedLog(MASP, 42n, MASP)];
        // Arbitrum: the EVM's block.number is the L1 height, not the receipt's.
        const { ctx } = stubCtx(undefined, logs, { blockNumber: 77n, l1BlockNumber: "0x3e8" });
        const out = await submitDepositAuthorized(ctx, {
            deposit: request(MASP),
            aux,
            feeAux: aux,
        });

        expect(out).toMatchObject({ txHash: TX, depositId: 42n, blockNumber: 77 });
        expect(out.escrowed).toMatchObject({
            id: 42n,
            publicAssetId: 1n,
            publicIn: 250n,
            feeBpsAtSubmit: 20,
            cm: request(MASP).outCm,
            cvDep: [23n, 24n],
            feeIn: 5n,
            feeAssetId: 2n,
            feeCm: request(MASP).feeCm,
            feeCvDep: [25n, 26n],
            submittedAt: 1_000,
        });
        expect(out.escrowed.payer.toLowerCase()).toBe(MASP.toLowerCase());
    });

    it("refuses a reverted deposit with its hash", async () => {
        const { ctx } = stubCtx(undefined, [], { status: "reverted" });
        await expect(
            submitDepositAuthorized(ctx, { deposit: request(MASP), aux, feeAux: aux }),
        ).rejects.toBeInstanceOf(TxRevertedError);
    });
});
