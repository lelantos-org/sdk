// Pins the relayer's error text, as `backend/crates/relayer/src/domain/error.rs`
// renders it, to the reason the SDK reads off it. The wire format is frozen: a
// failure here means the relayer's `client_message` changed and every wallet in
// the field reads that refusal as `unknown`.

import { describe, expect, it } from "vitest";
import { RelayerRejectedError, type RelayerRejectReason } from "../../errors/spend.js";
import {
    isSubmitOutcomeUnknown,
    parseRelayerRejectReason,
    SUBMIT_OUTCOME_UNKNOWN_MESSAGE,
} from "./reject-reason.js";

/** `(status(), client_message())` for each `AppError` variant, with representative payloads. */
const WIRE: ReadonlyArray<
    readonly [variant: string, status: number, body: string, reason: RelayerRejectReason]
> = [
    ["BadRequest", 400, "bad request: transfer requires publicOut == 0", "bad-request"],
    [
        "ContractRejected",
        400,
        "rejected by contract: execution reverted: UnknownRoot",
        "contract-rejected",
    ],
    ["UnknownChain", 404, "unknown chain: 31337", "unknown-chain"],
    ["NullifierAlreadySpent", 409, "nullifier already spent: chain 31337", "nullifier-spent"],
    ["NullifierInFlight", 409, "nullifier in flight: chain 31337", "nullifier-in-flight"],
    ["IdempotencyKeyReused", 409, "idempotency key reused: chain 31337", "idempotency-key-reused"],
    ["StaleEstimate", 409, "stale estimate: quote expired", "stale-estimate"],
    ["ShieldedFeeMissing", 402, "no shielded fee output addressed to lelantos1qqq", "fee-missing"],
    [
        "ShieldedFeeTooLow",
        402,
        "shielded fee in asset 1 pays 240 but 250 is required (grace 300 bps)",
        "fee-too-low",
    ],
    [
        "ShieldedFeeAssetRejected",
        402,
        "asset 7 cannot pay a shielded fee: yield-bearing",
        "fee-asset-rejected",
    ],
    ["Reverted", 502, "submit reverted", "reverted"],
    ["MirrorDesynced", 503, "relayer unavailable for this chain", "unavailable"],
    ["Internal", 500, "internal error", "internal"],
    // `Mirrored` repeats another caller's status and message verbatim.
    ["Mirrored(NullifierInFlight)", 409, "nullifier in flight: chain 1", "nullifier-in-flight"],
];

describe("parseRelayerRejectReason", () => {
    it.each(WIRE)("reads AppError::%s (%i) as its reason", (_variant, status, body, reason) => {
        expect(parseRelayerRejectReason(status, body)).toBe(reason);
    });

    it("reads text it does not recognise as unknown", () => {
        expect(parseRelayerRejectReason(409, "flush landed externally: batch 3")).toBe("unknown");
        expect(parseRelayerRejectReason(400, "<html>proxy error</html>")).toBe("unknown");
        expect(parseRelayerRejectReason(409, undefined)).toBe("unknown");
    });

    it("does not trust relayer text under a status the variant never uses", () => {
        expect(parseRelayerRejectReason(400, "nullifier already spent: chain 1")).toBe("unknown");
        expect(parseRelayerRejectReason(500, "stale estimate: x")).toBe("unknown");
    });

    it("recognises the unknown-outcome answer, which is not a refusal", () => {
        expect(SUBMIT_OUTCOME_UNKNOWN_MESSAGE).toBe(
            "submit outcome unknown; check the chain before retrying",
        );
        expect(isSubmitOutcomeUnknown(502, SUBMIT_OUTCOME_UNKNOWN_MESSAGE)).toBe(true);
        expect(parseRelayerRejectReason(502, SUBMIT_OUTCOME_UNKNOWN_MESSAGE)).toBe("unknown");
        expect(isSubmitOutcomeUnknown(502, "submit reverted")).toBe(false);
        expect(isSubmitOutcomeUnknown(500, SUBMIT_OUTCOME_UNKNOWN_MESSAGE)).toBe(false);
    });
});

describe("RelayerRejectedError", () => {
    it.each([
        ["nullifier-in-flight", true],
        ["stale-estimate", true],
        ["idempotency-key-reused", true],
        ["unavailable", true],
        ["internal", true],
        ["nullifier-spent", false],
        ["fee-too-low", false],
        ["bad-request", false],
        ["unknown", false],
    ] as const)("marks %s retryable: %s", (reason, retryable) => {
        const err = new RelayerRejectedError({ status: 409, reason, body: "x" });
        expect(err.retryable).toBe(retryable);
    });

    it("keeps the body off the message", () => {
        const body = "shielded fee in asset 1 pays 240 but 250 is required (grace 300 bps)";
        const err = new RelayerRejectedError({ status: 402, reason: "fee-too-low", body });
        expect(err.message).not.toContain("240");
        expect(err.body).toBe(body);
    });
});
