import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { branded, type EvmAddress, type Hex32 } from "../../core/brand.js";
import { TxMiningError, WalletConfigError } from "../../core/errors.js";
import type { EthSigner } from "../../core/signer.js";
import type { AuxOutput, DepositRequest, Permit2Sig } from "../../protocol/deposit-request.js";
import { MASP_ABI, NATIVE_ADAPTER_ABI } from "./abi.js";
import type { ViemCtx } from "./ctx.js";
import { submitDeposit, submitDepositAuthorized, submitDepositNative } from "./deposits.js";

// Which contract a deposit is sent to, and which function it encodes, are the
// two things that change silently: a call built against the old pool ABI is
// well-formed calldata that reverts on-chain, and a native deposit aimed at
// the pool reverts even though the calldata itself is fine.

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
function stubCtx(nativeAdapterAddress?: EvmAddress): { ctx: ViemCtx; sent: Sent[] } {
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
            waitForTransactionReceipt: async () => ({ logs: [] }),
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
            submitDeposit(ctx, { deposit: request(MASP), aux, permit2 }),
            sent,
        );

        expect(tx.to).toBe(MASP);
        expect(tx.value).toBeUndefined();
        expect(decodeFunctionData({ abi: MASP_ABI, data: tx.data! }).functionName).toBe("deposit");
    });

    it("sends the allowance deposit to the pool as `depositAuthorized`", async () => {
        const { ctx, sent } = stubCtx();
        const tx = await capture(
            submitDepositAuthorized(ctx, { deposit: request(MASP), aux }),
            sent,
        );

        expect(tx.to).toBe(MASP);
        expect(decodeFunctionData({ abi: MASP_ABI, data: tx.data! }).functionName).toBe(
            "depositAuthorized",
        );
    });

    /// The pool holds no native coin, so this one goes elsewhere entirely.
    it("sends the native deposit to the adapter, with the value attached", async () => {
        const { ctx, sent } = stubCtx(ADAPTER);
        const tx = await capture(
            submitDepositNative(ctx, { deposit: request(ADAPTER), aux, value: 1_000n }),
            sent,
        );

        expect(tx.to).toBe(ADAPTER);
        expect(tx.to).not.toBe(MASP);
        expect(tx.value).toBe(1_000n);
        const call = decodeFunctionData({ abi: NATIVE_ADAPTER_ABI, data: tx.data! });
        expect(call.functionName).toBe("depositNative");
        // `AdapterNotPayer` otherwise: the adapter wraps the coin, so the pool
        // pulls against its allowance, not the sender's. viem checksums what
        // it decodes, so compare case-insensitively.
        const payer = (call.args as readonly [{ payer: string }, unknown])[0].payer;
        expect(payer.toLowerCase()).toBe(ADAPTER.toLowerCase());
    });

    it("refuses a native deposit when no adapter is configured", async () => {
        const { ctx, sent } = stubCtx();
        await expect(
            submitDepositNative(ctx, { deposit: request(ADAPTER), aux, value: 1_000n }),
        ).rejects.toBeInstanceOf(WalletConfigError);
        expect(sent, "nothing should be broadcast").toHaveLength(0);
    });
});
