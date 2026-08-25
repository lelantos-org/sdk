import { describe, expect, it } from "vitest";
import { NetworkError } from "../../core/errors.js";
import { outcomeUnknown, submitSpend } from "./steps.js";

// `outcomeUnknown` decides whether a failed submit leaves notes spendable or
// reserved. Tested here on the errors themselves rather than through an
// executor, so a mis-sorted status shows up as one failing row.

const relayerError = (status?: number, body?: string) =>
    new NetworkError("RELAYER_FAILED", "/v1/spend", `HTTP ${status ?? "-"}`, {
        ...(status === undefined ? {} : { status }),
        ...(body === undefined ? {} : { body }),
    });

describe("outcomeUnknown", () => {
    it.each([
        ["a timeout, which may still have been received", relayerError(undefined)],
        ["a duplicate-spend rejection", relayerError(409, "nullifier in flight: chain 1")],
        [
            "a broadcast with no receipt",
            relayerError(502, "submit outcome unknown; check the chain"),
        ],
    ])("cannot rule out a spend after %s", (_case, err) => {
        expect(outcomeUnknown(err)).toBe(true);
    });

    it.each([
        ["a rejected payload", relayerError(400, "bad request: stale root")],
        ["an on-chain revert", relayerError(502, "submit reverted")],
        ["a relayer that broke before submitting", relayerError(500, "internal error")],
        ["an error that never reached the relayer", new Error("prover died")],
    ])("knows nothing was spent after %s", (_case, err) => {
        expect(outcomeUnknown(err)).toBe(false);
    });
});

describe("submitSpend", () => {
    const ctx = () => {
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
    };

    it("spends the notes once the relayer has the submission", async () => {
        const { ctx: c, calls } = ctx();
        await expect(submitSpend(c, ["01"], async () => "0xabc")).resolves.toBe("0xabc");
        expect(calls).toEqual({ spent: [["01"]], reserved: [] });
    });

    it("reserves them when it cannot tell, and still reports the failure", async () => {
        const { ctx: c, calls } = ctx();
        await expect(
            submitSpend(c, ["01"], async () => {
                throw relayerError(409, "nullifier in flight: chain 1");
            }),
        ).rejects.toThrow(/409/);
        expect(calls).toEqual({ spent: [], reserved: [["01"]] });
    });

    it("leaves them alone when the relayer said no", async () => {
        const { ctx: c, calls } = ctx();
        await expect(
            submitSpend(c, ["01"], async () => {
                throw relayerError(400, "bad request: stale root");
            }),
        ).rejects.toThrow();
        expect(calls).toEqual({ spent: [], reserved: [] });
    });
});
