import { describe, expect, it, vi } from "vitest";
import { NetworkError } from "../../errors/network.js";
import { SpendOutcomeUnknownError } from "../../errors/spend.js";
import type { SubmitTransactPayload, TransactPubInputs } from "../../protocol/transact.js";
import { submitSpend } from "../../wallet/tx/steps.js";
import { HttpRelayerSubmitter } from "./submitter.js";

// The submitter and the spend path together decide whether a failed submit is
// resent, and whether its notes stay spendable. Driven through the real HTTP
// transport so the retry policy and the outcome classification are tested as
// they compose.

const pubInputs: TransactPubInputs = {
    merkleRoot: 1n,
    nullifier: [2n],
    outCm: [3n],
    publicAssetId: 1n,
    publicIn: 0n,
    publicOut: 0n,
    inCv: [[4n, 5n]],
    outCv: [[6n, 7n]],
    recipient: "0x0000000000000000000000000000000000000001",
    chainId: 31337n,
    payer: "0x0000000000000000000000000000000000000002",
    relayer: "0x0000000000000000000000000000000000000003",
    intentHash: 0n,
    outCvDep: [[8n, 9n]],
};

const payload: SubmitTransactPayload = {
    chainId: 31337n,
    kind: "transfer",
    proof: "0x00",
    pubInputs,
    aux: [],
} as unknown as SubmitTransactPayload;

/** A fetch that plays `script` in order, one step per attempt. */
function scripted(script: Array<number | "hang">) {
    let i = 0;
    return vi.fn(async (_u: string, init?: RequestInit) => {
        const step = script[Math.min(i++, script.length - 1)] ?? 200;
        if (step === "hang") {
            return new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
        }
        return new Response(step === 200 ? '{"txHash":"0xabc"}' : `status ${step}`, {
            status: step,
        });
    }) as unknown as typeof fetch & { mock: { calls: unknown[] } };
}

function notes() {
    const calls = { spent: [] as string[][], reserved: [] as string[][] };
    return {
        calls,
        ctx: {
            markSpent: async (ids: string[]) => {
                calls.spent.push(ids);
            },
            markPendingSpend: async (ids: string[]) => {
                calls.reserved.push(ids);
            },
        },
    };
}

describe("HttpRelayerSubmitter retry policy", () => {
    it.each([500, 502])("does not resend a submit answered %i", async (status) => {
        const fetchImpl = scripted([status, 200]);
        const submitter = new HttpRelayerSubmitter("https://relayer.test", {
            fetch: fetchImpl,
            backoffMs: 1,
        });

        await expect(submitter.submit(payload)).rejects.toMatchObject({ status });
        expect(fetchImpl.mock.calls).toHaveLength(1);
    });

    it("resends a submit refused with 503", async () => {
        const fetchImpl = scripted([503, 200]);
        const submitter = new HttpRelayerSubmitter("https://relayer.test", {
            fetch: fetchImpl,
            backoffMs: 1,
        });

        await expect(submitter.submit(payload)).resolves.toEqual({ txHash: "0xabc" });
        expect(fetchImpl.mock.calls).toHaveLength(2);
    });
});

describe("submitSpend over HTTP", () => {
    it("reserves the notes when the last attempt timed out after a 503", async () => {
        const submitter = new HttpRelayerSubmitter("https://relayer.test", {
            fetch: scripted([503, "hang"]),
            backoffMs: 1,
            retries: 1,
            submitTimeoutMs: 5,
        });
        const { ctx, calls } = notes();

        const err = await submitSpend(ctx, ["n1"], () => submitter.submit(payload)).catch(
            (e: unknown) => e,
        );

        expect(err).toBeInstanceOf(SpendOutcomeUnknownError);
        expect((err as SpendOutcomeUnknownError).reservedNoteIds).toEqual(["n1"]);
        const cause = (err as Error).cause;
        expect(cause).toBeInstanceOf(NetworkError);
        expect((cause as NetworkError).status).toBeUndefined();
        expect(calls).toEqual({ spent: [], reserved: [["n1"]] });
    });

    it("reserves the notes when a timed-out attempt was followed by a refusal", async () => {
        const submitter = new HttpRelayerSubmitter("https://relayer.test", {
            fetch: scripted(["hang", 400]),
            backoffMs: 1,
            retries: 1,
            submitTimeoutMs: 5,
        });
        const { ctx, calls } = notes();

        const err = await submitSpend(ctx, ["n1"], () => submitter.submit(payload)).catch(
            (e: unknown) => e,
        );
        expect(err).toMatchObject({ code: "SPEND_OUTCOME_UNKNOWN", retryable: false });
        expect((err as Error).cause).toMatchObject({
            status: 400,
            attempts: [{}, { status: 400 }],
        });
        expect(calls).toEqual({ spent: [], reserved: [["n1"]] });
    });

    it("leaves the notes spendable after a definite 500", async () => {
        const submitter = new HttpRelayerSubmitter("https://relayer.test", {
            fetch: scripted([500]),
            backoffMs: 1,
        });
        const { ctx, calls } = notes();

        // A 500 stays a (retryable) transport failure: not a refusal, not "may have landed".
        await expect(
            submitSpend(ctx, ["n1"], () => submitter.submit(payload)),
        ).rejects.toMatchObject({ code: "RELAYER_FAILED", status: 500, retryable: true });
        expect(calls).toEqual({ spent: [], reserved: [] });
    });
});
