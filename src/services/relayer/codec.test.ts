import { describe, expect, it } from "vitest";
import { isWalletError } from "../../core/errors.js";
import type { DepositRequest } from "../../protocol/deposit-request.js";
import type {
    SubmitDepositPayload,
    SubmitSwapPayload,
    SubmitTransactPayload,
    TransactAux,
    TransactPubInputs,
} from "../../protocol/transact.js";
import {
    deserializeMerkleProof,
    deserializeScannedNote,
    serializeSubmitDeposit,
    serializeSubmitSwap,
    serializeSubmitTransact,
} from "./codec.js";

// Golden fixtures.
//
// The same three DepositRequest fields go out as decimal strings to /v1/deposit
// and as JSON numbers inside /v1/swap, because the relayer's Rust DTOs declare
// them differently (String vs u64, and serde's u64 rejects strings). Unifying
// the two encodings breaks one endpoint; these fixtures make that change fail
// here rather than in production.

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
    it("/v1/deposit sends the request's u64 fields as DECIMAL STRINGS", () => {
        const payload: SubmitDepositPayload = {
            chainId: 31337n,
            deposit,
            permit2: { nonce: 1n, deadline: 2n, maxTotal: 3n, signature: "0xsig" },
            aux: { clueRx: 1n, clueRy: 2n, ephPubX: 3n, ephPubY: 4n, ciphertext: new Uint8Array() },
            feeAux: {
                clueRx: 5n,
                clueRy: 6n,
                ephPubX: 7n,
                ephPubY: 8n,
                ciphertext: new Uint8Array(),
            },
        };
        const out = serializeSubmitDeposit(payload) as {
            chainId: unknown;
            deposit: Record<string, unknown>;
        };

        // Envelope chainId is a number; the request's three are strings.
        expect(out.chainId).toBe(31337);
        expect(out.deposit.chainId).toBe("31337");
        expect(out.deposit.publicAssetId).toBe("1");
        expect(out.deposit.publicIn).toBe("250");
    });

    it("/v1/deposit carries the whole DepositRequest, both notes included", () => {
        // A relayer rebuilds `PubInputs.DepositRequest` from this payload and
        // broadcasts it; dropping any field leaves it unable to, and `rcv` /
        // `feeRcv` are private witnesses it can learn no other way. The `fee*`
        // group is the leaf that pays the relayer, and it is digest preimage:
        // a payload missing it cannot be flushed at all.
        const payload: SubmitDepositPayload = {
            chainId: 31337n,
            deposit,
            permit2: { nonce: 1n, deadline: 2n, maxTotal: 3n, signature: "0xsig" },
            aux: { clueRx: 1n, clueRy: 2n, ephPubX: 3n, ephPubY: 4n, ciphertext: new Uint8Array() },
            feeAux: {
                clueRx: 5n,
                clueRy: 6n,
                ephPubX: 7n,
                ephPubY: 8n,
                ciphertext: new Uint8Array(),
            },
        };
        const out = serializeSubmitDeposit(payload) as { deposit: Record<string, unknown> };

        expect(Object.keys(out.deposit).sort()).toEqual(
            [
                "chainId",
                "cvDep",
                "outCm",
                "payer",
                "publicAssetId",
                "publicIn",
                "recipient",
                "rcv",
                "feeIn",
                "feeCm",
                "feeCvDep",
                "feeRcv",
            ].sort(),
        );
        expect(out.deposit.cvDep).toEqual(["23", "24"]);
        expect(out.deposit.rcv).toBe("27");
        // Decimal strings, like the rest of /v1/deposit's request body.
        expect(out.deposit.feeIn).toBe("5");
        expect(out.deposit.feeCvDep).toEqual(["25", "26"]);
        expect(out.deposit.feeRcv).toBe("28");
    });

    it("/v1/swap sends the SAME three deposit fields as JSON NUMBERS", () => {
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

describe("inbound validation", () => {
    it("decodes a well-formed merkle proof", () => {
        const d = deserializeMerkleProof({
            leafIndex: 3,
            pathElements: [["1", "2", "3"]],
            pathIndices: [0],
            root: "0x2a",
        });
        expect(d.leafIndex).toBe(3);
        expect(d.pathElements).toEqual([[1n, 2n, 3n]]);
        expect(d.root).toBe(42n);
    });

    it("names the exact path of a bad value instead of throwing a TypeError", () => {
        const err = (() => {
            try {
                deserializeMerkleProof({
                    leafIndex: 3,
                    pathElements: [["1", null]],
                    pathIndices: [0],
                    root: "1",
                });
            } catch (e) {
                return e as Error & { path?: string };
            }
        })();
        expect(isWalletError(err, "WIRE_FORMAT")).toBe(true);
        expect(err?.path).toBe("$.pathElements[0][1]");
        expect(err?.message).toContain("expected a decimal or 0x-hex integer");
    });

    it("rejects a non-object response", () => {
        expect(() => deserializeMerkleProof("nope")).toThrow(/expected an object/);
    });

    it("rejects a missing field rather than yielding undefined downstream", () => {
        expect(() => deserializeMerkleProof({ leafIndex: 1, root: "1" })).toThrow(
            /\$\.pathElements/,
        );
    });

    it("rejects odd-length hex in a scanned note", () => {
        expect(() =>
            deserializeScannedNote({
                ciphertext: "0xabc",
                clueR: ["1", "2"],
                ephPub: ["3", "4"],
                cm: "5",
                leafIndex: 0,
            }),
        ).toThrow(/even-length hex/);
    });

    it("rejects a wrong-arity point", () => {
        const err = (() => {
            try {
                deserializeScannedNote({
                    ciphertext: "0x",
                    clueR: ["1"],
                    ephPub: ["3", "4"],
                    cm: "5",
                    leafIndex: 0,
                });
            } catch (e) {
                return e as Error & { path?: string };
            }
        })();
        expect(err?.path).toBe("$.clueR");
        expect(err?.message).toContain("length 2");
    });
});
