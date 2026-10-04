import { describe, expect, it } from "vitest";
import { isWalletError } from "../../errors/guard.js";
import type { OutputAux } from "../../notes/aux.js";
import type { DepositRequest } from "../../protocol/deposit-request.js";
import type {
    SubmitSwapPayload,
    SubmitTransactPayload,
    TransactPubInputs,
} from "../../protocol/transact.js";
import { serializeSubmitSwap, serializeSubmitTransact } from "./codec.js";

// Golden fixtures for the two outbound bigint encodings described in
// `codec.ts`: JSON numbers for `u64` DTO fields, decimal strings for field
// elements and U256 values.

const aux: OutputAux = {
    clueR: [1n, 2n],
    clueQ: [5n, 6n],
    ephPub: [3n, 4n],
    ciphertext: new Uint8Array([0xde, 0xad]),
};

const pubInputs: TransactPubInputs = {
    merkleRoot: 111n,
    nullifier: [7n, 8n],
    outCm: [9n, 10n],
    publicAssetId: 1n,
    publicOut: 500n,
    digest: 2n ** 252n + 3n,
    recipient: "0xrecipient",
    chainId: 31337n,
    payer: "0xpayer",
    relayer: "0xrelayer",
    intentHash: 2n ** 253n + 1n,
};

const deposit: DepositRequest = {
    chainId: 31337n,
    publicAssetId: 1n,
    publicIn: 250n,
    payer: "0xpayer",
    recipient: "0xrecipient",
    inner: "0xinner",
    feeAssetId: 1n,
    feeIn: 5n,
    feeInner: "0xfeeinner",
};

const proof = { piA: ["1"], piB: [["2"]], piC: ["3"] };

describe("outbound encoding (golden)", () => {
    it("/v1/swap sends the deposit request's three u64 fields as JSON NUMBERS", () => {
        const payload: SubmitSwapPayload = {
            chainId: 31337n,
            proof,
            pubInputs,
            aux: [aux, aux],
            swap: {
                adapter: "0xadapter",
                route: "0xroute",
                depositD: deposit,
                auxD: aux,
                feeAuxD: aux,
                refundD: { ...deposit, publicAssetId: 2n, feeAssetId: 2n },
                refundAuxD: aux,
                refundFeeAuxD: aux,
                tokenIn: "0xin",
                tokenOut: "0xout",
                amountIn: 10n ** 30n,
                minOut: 10n ** 29n,
                deadline: 1_900_000_000n,
                refundTo: "0xrefund",
            },
        };
        const out = serializeSubmitSwap(payload) as {
            swap: {
                depositD: Record<string, unknown>;
                refundD: Record<string, unknown>;
                amountIn: unknown;
                deadline: unknown;
                refundTo: unknown;
            };
        };

        expect(out.swap.depositD.chainId).toBe(31337);
        // `feeIn` and `feeAssetId` are u64 in the swap DTO too.
        expect(out.swap.depositD.feeIn).toBe(5);
        expect(out.swap.depositD.feeAssetId).toBe(1);
        expect(out.swap.refundD.feeAssetId).toBe(2);
        expect(out.swap.depositD.publicAssetId).toBe(1);
        expect(out.swap.depositD.publicIn).toBe(250);
        // The refund deposit is the same DTO, under its own key.
        expect(out.swap.refundD.publicAssetId).toBe(2);
        expect(out.swap.refundD.feeIn).toBe(5);
        // U256 amounts stay strings, as they routinely exceed 2^53.
        expect(out.swap.amountIn).toBe((10n ** 30n).toString());
        // The deadline is intent-hashed, so it is always sent, never left to
        // a relayer default; a decimal string like the other U256 words.
        expect(out.swap.deadline).toBe("1900000000");
        // An address, sent verbatim as hex.
        expect(out.swap.refundTo).toBe("0xrefund");
    });

    it("/v1/spend encodes pubInputs u64 slots as numbers and fields as strings", () => {
        const payload: SubmitTransactPayload = {
            chainId: 31337n,
            kind: "withdraw",
            proof,
            pubInputs,
            aux: [aux, aux],
        };
        const out = serializeSubmitTransact(payload) as {
            kind: string;
            pubInputs: Record<string, unknown>;
        };
        expect(out.kind).toBe("withdraw");
        expect(out.pubInputs.publicOut).toBe(500);
        expect(out.pubInputs.merkleRoot).toBe("111");
        // `intentHash` is a full field word like `merkleRoot`: a decimal
        // string, exact past 2^53.
        expect(out.pubInputs.intentHash).toBe((2n ** 253n + 1n).toString());
        // So is `digest`.
        expect(out.pubInputs.digest).toBe((2n ** 252n + 3n).toString());
    });

    it("/v1/spend pubInputs carry exactly the `PubInputs.Transact` members", () => {
        const out = serializeSubmitTransact({
            chainId: 31337n,
            kind: "transfer",
            proof,
            pubInputs,
            aux: [aux, aux],
        }) as { pubInputs: Record<string, unknown> };
        expect(Object.keys(out.pubInputs)).toEqual([
            "merkleRoot",
            "nullifier",
            "outCm",
            "publicAssetId",
            "publicOut",
            "digest",
            "recipient",
            "chainId",
            "payer",
            "relayer",
            "intentHash",
        ]);
    });

    it("/v1/swap deposit requests carry exactly the `PubInputs.DepositRequest` members", () => {
        const out = serializeSubmitSwap({
            chainId: 31337n,
            proof,
            pubInputs,
            aux: [aux, aux],
            swap: {
                adapter: "0xadapter",
                route: "0xroute",
                depositD: deposit,
                auxD: aux,
                feeAuxD: aux,
                refundD: deposit,
                refundAuxD: aux,
                refundFeeAuxD: aux,
                tokenIn: "0xin",
                tokenOut: "0xout",
                amountIn: 1n,
                minOut: 1n,
                deadline: 1n,
                refundTo: "0xrefund",
            },
        }) as { swap: { depositD: Record<string, unknown> } };
        expect(Object.keys(out.swap.depositD)).toEqual([
            "chainId",
            "publicAssetId",
            "publicIn",
            "payer",
            "recipient",
            "inner",
            "feeAssetId",
            "feeIn",
            "feeInner",
        ]);
        // `inner` words go out verbatim as hex, like the addresses.
        expect(out.swap.depositD.inner).toBe("0xinner");
        expect(out.swap.depositD.feeInner).toBe("0xfeeinner");
    });

    it("refuses to truncate a fee asset id past 2^53", () => {
        const big = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
        const swap = {
            adapter: "0xadapter",
            route: "0xroute",
            depositD: { ...deposit, feeAssetId: big },
            auxD: aux,
            feeAuxD: aux,
            refundD: deposit,
            refundAuxD: aux,
            refundFeeAuxD: aux,
            tokenIn: "0xin",
            tokenOut: "0xout",
            amountIn: 1n,
            minOut: 1n,
            deadline: 1n,
            refundTo: "0xrefund",
        };
        expect(() =>
            serializeSubmitSwap({ chainId: 31337n, proof, pubInputs, aux: [aux], swap }),
        ).toThrow(/depositD\.feeAssetId/);
    });

    // `Number(bigint)` truncates silently, and publicAssetId is an uncapped u64.
    it("refuses to truncate a u64 field past 2^53 instead of corrupting it", () => {
        const big = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
        const payload: SubmitTransactPayload = {
            chainId: 31337n,
            kind: "transfer",
            proof,
            pubInputs: { ...pubInputs, publicAssetId: big },
            aux: [aux, aux],
        };
        const err = (() => {
            try {
                serializeSubmitTransact(payload);
            } catch (e) {
                return e;
            }
        })();
        expect(isWalletError(err, "WIRE_FORMAT")).toBe(true);
        expect((err as Error).message).toContain("publicAssetId");
    });
});
