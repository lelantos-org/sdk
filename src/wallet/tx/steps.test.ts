import { describe, expect, it } from "vitest";
import { NetworkError } from "../../core/errors.js";
import { outcomeUnknown, splitChange, submitSpend } from "./steps.js";

// Change goes out as real notes, so the split is part of what an observer
// sees. These pin the two properties that matter: the notes sum to the
// remainder exactly, and the two-slot case is unchanged from when the split
// was hardcoded to a pair.

const PK = 7n;
const ASSET = 1n;
const values = (remainder: bigint, slots: number) =>
    splitChange(PK, ASSET, remainder, slots).map((n) => n.value);

describe("splitChange", () => {
    it("reproduces the original two-slot pair, remainder last", () => {
        expect(values(5n, 2)).toEqual([2n, 3n]);
        expect(values(4n, 2)).toEqual([2n, 2n]);
        expect(values(1n, 2)).toEqual([0n, 1n]);
    });

    it("spreads an indivisible remainder over the last slots", () => {
        expect(values(7n, 3)).toEqual([2n, 2n, 3n]);
        expect(values(8n, 3)).toEqual([2n, 3n, 3n]);
        expect(values(9n, 3)).toEqual([3n, 3n, 3n]);
    });

    it("always sums to the remainder", () => {
        for (const slots of [1, 2, 3, 4]) {
            for (const r of [0n, 1n, 2n, 97n, 10n ** 18n + 7n]) {
                const out = values(r, slots);
                expect(out).toHaveLength(slots);
                expect(out.reduce((a, b) => a + b, 0n)).toBe(r);
            }
        }
    });

    it("carries the asset and owner onto every slot", () => {
        const notes = splitChange(PK, ASSET, 10n, 3);
        expect(notes.every((n) => n.pk === PK && n.asset === ASSET)).toBe(true);
        // Randomness is fresh per note, so no two share a rho.
        expect(new Set(notes.map((n) => n.rho)).size).toBe(3);
    });

    it("rejects a zero-slot split", () => {
        expect(() => splitChange(PK, ASSET, 10n, 0)).toThrow(/at least one slot/);
    });
});

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
