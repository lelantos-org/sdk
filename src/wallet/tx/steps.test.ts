import { describe, expect, it, vi } from "vitest";
import { NOTE_PAYLOAD_TOPIC, ROOT_ADVANCED_TOPIC } from "../../chain/operation.js";
import type { ChainReader } from "../../chain/port.js";
import type { TxLog } from "../../chain/types.js";
import type { EvmAddress, Hex32 } from "../../core/brand.js";
import { NetworkError } from "../../errors/network.js";
import { RelayerRejectedError, SpendOutcomeUnknownError } from "../../errors/spend.js";
import type { TransferResult } from "../types/results.js";
import { classifySubmitFailure, outcomeUnknown, submitSpend, withOperation } from "./steps.js";

// `outcomeUnknown` and `classifySubmitFailure` decide whether a failed submit
// leaves notes spendable or reserved, and what the caller is told. Tested
// directly on errors so each status is its own case.

const relayerError = (status?: number, body?: string) =>
    new NetworkError("RELAYER_FAILED", "/v1/spend", `HTTP ${status ?? "-"}`, {
        ...(status === undefined ? {} : { status }),
        ...(body === undefined ? {} : { body }),
    });

describe("outcomeUnknown", () => {
    it.each([
        ["a timeout, which may still have been received", relayerError(undefined)],
        [
            "a broadcast with no receipt",
            relayerError(502, "submit outcome unknown; check the chain before retrying"),
        ],
    ])("cannot rule out a spend after %s", (_case, err) => {
        expect(outcomeUnknown(err)).toBe(true);
    });

    it("cannot rule out a spend when an earlier attempt got no response", () => {
        // The resend carried the same Idempotency-Key; a definite answer to it
        // says nothing about whether the first copy landed.
        const err = new NetworkError("RELAYER_FAILED", "/v1/spend", "HTTP 400", {
            status: 400,
            body: "bad request: nullifier already used",
            attempts: [{}, { status: 400, body: "bad request: nullifier already used" }],
        });
        expect(outcomeUnknown(err)).toBe(true);
    });

    it("knows nothing was spent when every attempt was refused", () => {
        const err = new NetworkError("RELAYER_FAILED", "/v1/spend", "HTTP 400", {
            status: 400,
            body: "bad request: stale root",
            attempts: [{ status: 429 }, { status: 400, body: "bad request: stale root" }],
        });
        expect(outcomeUnknown(err)).toBe(false);
    });

    it.each([
        [
            "a duplicate-spend rejection, which is a definite answer",
            relayerError(409, "nullifier in flight: chain 1"),
        ],
        ["a rejected payload", relayerError(400, "bad request: stale root")],
        ["an on-chain revert", relayerError(502, "submit reverted")],
        ["a relayer that broke before submitting", relayerError(500, "internal error")],
        ["an error that never reached the relayer", new Error("prover died")],
    ])("is not unknown after %s", (_case, err) => {
        expect(outcomeUnknown(err)).toBe(false);
    });
});

describe("classifySubmitFailure", () => {
    it.each([
        ["nullifier already spent: chain 1", "nullifier-spent", true],
        ["nullifier in flight: chain 1", "nullifier-in-flight", true],
        ["stale estimate: quote expired", "stale-estimate", true],
        ["idempotency key reused: chain 1", "idempotency-key-reused", false],
    ] as const)("a 409 %s reads %s (reserve: %s)", (body, reason, reserve) => {
        expect(classifySubmitFailure(relayerError(409, body))).toEqual({
            kind: "rejected",
            status: 409,
            body,
            reason,
            reserve,
        });
    });

    it("reads any 4xx and a 502 revert as a refusal that leaves notes alone", () => {
        expect(
            classifySubmitFailure(relayerError(402, "no shielded fee output addressed to x")),
        ).toMatchObject({
            kind: "rejected",
            reason: "fee-missing",
            reserve: false,
        });
        expect(classifySubmitFailure(relayerError(502, "submit reverted"))).toMatchObject({
            kind: "rejected",
            reason: "reverted",
        });
    });

    it("leaves a 500 and a 503 as transport failures", () => {
        expect(classifySubmitFailure(relayerError(500, "internal error"))).toEqual({
            kind: "other",
        });
        expect(
            classifySubmitFailure(relayerError(503, "relayer unavailable for this chain")),
        ).toEqual({
            kind: "other",
        });
        expect(classifySubmitFailure(new Error("prover died"))).toEqual({ kind: "other" });
    });
});

describe("submitSpend", () => {
    const ctx = () => {
        const calls = { spent: [] as string[][], reserved: [] as string[][], resynced: 0 };
        return {
            calls,
            ctx: {
                markSpent: async (ids: string[]) => {
                    calls.spent.push(ids);
                },
                markPendingSpend: async (ids: string[]) => {
                    calls.reserved.push(ids);
                },
                resyncSpent: async () => {
                    calls.resynced++;
                },
            },
        };
    };

    it("spends the notes once the relayer has the submission", async () => {
        const { ctx: c, calls } = ctx();
        await expect(submitSpend(c, ["01"], async () => "0xabc")).resolves.toBe("0xabc");
        expect(calls).toEqual({ spent: [["01"]], reserved: [], resynced: 0 });
    });

    it("reserves them when it cannot tell, and reports an unknown outcome", async () => {
        const { ctx: c, calls } = ctx();
        const cause = relayerError(undefined);
        const err = await submitSpend(c, ["01", "02"], async () => {
            throw cause;
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(SpendOutcomeUnknownError);
        const unknown = err as SpendOutcomeUnknownError;
        expect(unknown).toMatchObject({
            code: "SPEND_OUTCOME_UNKNOWN",
            retryable: false,
            reservedNoteIds: ["01", "02"],
        });
        expect(unknown.reservedUntil.getTime()).toBeGreaterThan(Date.now());
        expect(unknown.cause).toBe(cause);
        expect(calls).toEqual({ spent: [], reserved: [["01", "02"]], resynced: 0 });
    });

    it("reserves them on a nullifier in flight and reports a retryable refusal", async () => {
        const { ctx: c, calls } = ctx();
        const err = await submitSpend(c, ["01"], async () => {
            throw relayerError(409, "nullifier in flight: chain 1");
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(RelayerRejectedError);
        expect(err).toMatchObject({
            code: "RELAYER_REJECTED",
            status: 409,
            reason: "nullifier-in-flight",
            retryable: true,
            reservedNoteIds: ["01"],
        });
        expect(calls).toEqual({ spent: [], reserved: [["01"]], resynced: 0 });
    });

    it("resyncs the spent set before reporting an already-spent nullifier", async () => {
        const { ctx: c, calls } = ctx();
        const order: string[] = [];
        c.resyncSpent = async () => {
            order.push("resync");
            calls.resynced++;
        };
        const err = await submitSpend(c, ["01"], async () => {
            throw relayerError(409, "nullifier already spent: chain 1");
        }).catch((e: unknown) => {
            order.push("thrown");
            return e;
        });

        expect(err).toMatchObject({ reason: "nullifier-spent", retryable: false });
        expect(order).toEqual(["resync", "thrown"]);
        expect(calls.reserved).toEqual([["01"]]);
    });

    it("still reports the refusal when the resync fails", async () => {
        const { ctx: c } = ctx();
        c.resyncSpent = vi.fn(async () => {
            throw new Error("fmd down");
        });
        await expect(
            submitSpend(c, ["01"], async () => {
                throw relayerError(409, "nullifier already spent: chain 1");
            }),
        ).rejects.toMatchObject({ code: "RELAYER_REJECTED", reason: "nullifier-spent" });
    });

    it("leaves them alone when the relayer said no", async () => {
        const { ctx: c, calls } = ctx();
        await expect(
            submitSpend(c, ["01"], async () => {
                throw relayerError(400, "bad request: stale root");
            }),
        ).rejects.toMatchObject({
            code: "RELAYER_REJECTED",
            reason: "bad-request",
            retryable: false,
            reservedNoteIds: [],
        });
        expect(calls).toEqual({ spent: [], reserved: [], resynced: 0 });
    });
});

describe("withOperation", () => {
    const POOL = "0x2887cDe0763178e199A99289dbA9b46DB4d9DB2e" as EvmAddress;
    const word = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex32;
    const cms = [word(0xa1), word(0xa2)];
    const result = {
        kind: "transfer",
        txHash: word(0xdead),
        commitments: cms,
    } as unknown as TransferResult;
    const root: TxLog = { address: POOL, topics: [ROOT_ADVANCED_TOPIC, word(0)] };
    const payload = (cm: Hex32): TxLog => ({ address: POOL, topics: [NOTE_PAYLOAD_TOPIC, cm] });
    const chain = (logs: () => Promise<readonly TxLog[]>) =>
        ({
            maspAddress: async () => POOL,
            txReceiptLogs: vi.fn(logs),
        }) as unknown as ChainReader;

    it("attaches the operation's place in a bundled tx", async () => {
        const c = chain(async () => [root, payload(word(0xb1)), root, ...cms.map(payload)]);
        const out = await withOperation(c, result);
        expect(out.operation).toEqual({ index: 1, count: 2, logRange: [2, 4] });
        // Only the hash is handed to the adapter; the matching stays local.
        expect(c.txReceiptLogs).toHaveBeenCalledWith(result.txHash);
    });

    it("leaves the result untouched when the receipt cannot be read", async () => {
        const out = await withOperation(
            chain(async () => {
                throw new Error("receipt not found");
            }),
            result,
        );
        expect(out).toBe(result);
        expect(out.operation).toBeUndefined();
    });

    it("leaves it untouched for an adapter without receipt logs", async () => {
        const c = { maspAddress: async () => POOL } as unknown as ChainReader;
        expect(await withOperation(c, result)).toBe(result);
    });
});
