import { describe, expect, it } from "vitest";
import { NetworkError, WireFormatError } from "../../core/errors.js";
import { isShieldedFeeRejection } from "./client.js";

const netErr = (status: number, body?: string) =>
    new NetworkError("RELAYER_FAILED", "https://relayer.test/v1/spend", `HTTP ${status}`, {
        status,
        ...(body === undefined ? {} : { body }),
    });

describe("isShieldedFeeRejection", () => {
    it("recognises the relayer's 402 and keeps its reason reachable", () => {
        const err = netErr(
            402,
            "shielded fee in asset 1 pays 240 but 250 is required (grace 300 bps)",
        );
        expect(isShieldedFeeRejection(err)).toBe(true);
        // Narrowed, so `.body` is reachable without a cast.
        if (isShieldedFeeRejection(err)) expect(err.body).toContain("is required");
    });

    // Every other relayer refusal has its own remedy; treating them as a fee
    // problem would mean re-quoting forever.
    it("does not fire on the relayer's other refusals", () => {
        for (const status of [400, 404, 409, 500, 502, 503]) {
            expect(isShieldedFeeRejection(netErr(status))).toBe(false);
        }
    });

    it("does not fire on a transport failure with no status", () => {
        expect(
            isShieldedFeeRejection(
                new NetworkError("RELAYER_TIMEOUT", "https://relayer.test", "timed out"),
            ),
        ).toBe(false);
    });

    it("does not fire on unrelated throwables", () => {
        for (const other of [
            new WireFormatError("$.x", "bad"),
            new Error("boom"),
            undefined,
            402,
        ]) {
            expect(isShieldedFeeRejection(other)).toBe(false);
        }
    });
});
