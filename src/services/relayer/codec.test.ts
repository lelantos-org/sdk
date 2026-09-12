import { describe, expect, it } from "vitest";
import { isWalletError } from "../../core/errors.js";
import type { DepositRequest } from "../../protocol/deposit-request.js";
import type {
    SubmitSwapPayload,
    SubmitTransactPayload,
    TransactAux,
    TransactPubInputs,
} from "../../protocol/transact.js";
import { serializeSubmitSwap, serializeSubmitTransact } from "./codec.js";

// Golden fixtures.
//
// A DepositRequest's `chainId`, `publicAssetId` and `publicIn` go out as JSON
// numbers inside /v1/swap, because the relayer's Rust DTO declares them `u64`
// and serde's u64 deserializer rejects strings — while every field element and
// U256 beside them goes out as a decimal string. These fixtures make a change
// to either encoding fail here rather than in production.

const aux: TransactAux = {
    clueR: [1n, 2n],
    ephPub: [3n, 4n],
    ciphertext: new Uint8Array([0xde, 0xad]),
};

const pubInputs: TransactPubInputs = {
    merkleRoot: 111n,
    nullifier: [7n, 8n],
    outCm: [9n, 10n],
    publicAssetId: 1n,
    publicIn: 0n,
    publicOut: 500n,
    inCv: [
        [11n, 12n],
        [13n, 14n],
    ],
    outCv: [
        [15n, 16n],
        [17n, 18n],
    ],
    recipient: "0xrecipient",
    chainId: 31337n,
    payer: "0xpayer",
    relayer: "0xrelayer",
    outCvDep: [
        [19n, 20n],
        [21n, 22n],
    ],
};

const deposit: DepositRequest = {
    chainId: 31337n,
    publicAssetId: 1n,
    publicIn: 250n,
    payer: "0xpayer",
    recipient: "0xrecipient",
    outCm: "0xcm0",
    cvDep: [23n, 24n],
    rcv: 27n,
    feeIn: 5n,
    feeCm: "0xfeecm",
    feeCvDep: [25n, 26n],
    feeRcv: 28n,
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
                tokenIn: "0xin",
                tokenOut: "0xout",
                amountIn: 10n ** 30n,
                minOut: 10n ** 29n,
            },
        };
        const out = serializeSubmitSwap(payload) as {
            swap: { depositD: Record<string, unknown>; amountIn: unknown; deadline: unknown };
        };

        expect(out.swap.depositD.chainId).toBe(31337);
        // `feeIn` is a u64 in the swap DTO too, so it follows the same rule.
        expect(out.swap.depositD.feeIn).toBe(5);
        expect(out.swap.depositD.publicAssetId).toBe(1);
        expect(out.swap.depositD.publicIn).toBe(250);
        // U256 amounts stay strings — they exceed 2^53 routinely.
        expect(out.swap.amountIn).toBe((10n ** 30n).toString());
        expect(out.swap.deadline).toBeNull();
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
        expect(out.pubInputs.inCv).toEqual([
            { x: "11", y: "12" },
            { x: "13", y: "14" },
        ]);
    });

    // `Number(bigint)` truncates silently, and publicAssetId is an uncapped
    // u64.
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
