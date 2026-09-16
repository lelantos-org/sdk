// The relayer's refusal, as a machine-readable reason.
//
// The relayer answers an error with `(status, client_message)` as plain text
// (`IntoResponse for AppError` in `backend/crates/relayer/src/domain/error.rs`);
// there is no structured error field on the wire. Each `AppError` variant
// renders a fixed prefix, so the reason is read off that prefix, qualified by
// the status the variant maps to. The wire format is frozen: `reject-reason.test.ts`
// pins every string below against the backend's rendering.
//
// This is the only place that reads relayer error text. Everything downstream
// branches on `RelayerRejectReason`.

import type { RelayerRejectReason } from "../../errors/spend.js";

/** `client_message` prefixes, one per `AppError` variant a submission can meet. */
const PREFIXES: ReadonlyArray<
    readonly [status: number, prefix: string, reason: RelayerRejectReason]
> = [
    // 409
    [409, "nullifier already spent: ", "nullifier-spent"],
    [409, "nullifier in flight: ", "nullifier-in-flight"],
    [409, "idempotency key reused: ", "idempotency-key-reused"],
    [409, "stale estimate: ", "stale-estimate"],
    // 402
    [402, "no shielded fee output addressed to ", "fee-missing"],
    [402, "shielded fee in asset ", "fee-too-low"],
    // 400
    [400, "rejected by contract: ", "contract-rejected"],
    [400, "bad request: ", "bad-request"],
    // 404
    [404, "unknown chain: ", "unknown-chain"],
    // 502; "submit outcome unknown…" is not a refusal, see `isSubmitOutcomeUnknown`.
    [502, "submit reverted", "reverted"],
    // 503
    [503, "relayer unavailable for this chain", "unavailable"],
    // 500
    [500, "internal error", "internal"],
];

/** `asset {id} cannot pay a shielded fee: {reason}` — the id sits before the fixed part. */
const FEE_ASSET_REJECTED = /^asset \d+ cannot pay a shielded fee: /;

/**
 * `AppError::SubmitUnknown`'s message: the relayer broadcast the transaction and
 * saw no receipt, so the spend may have landed.
 */
export const SUBMIT_OUTCOME_UNKNOWN_MESSAGE =
    "submit outcome unknown; check the chain before retrying";

/**
 * Why the relayer refused, from its HTTP status and response text.
 *
 * `unknown` for text this SDK version does not recognise (a newer relayer, a
 * proxy's error page). A status that disagrees with the prefix also reads
 * `unknown`, so a proxy echoing relayer text under another status is not
 * trusted.
 */
export function parseRelayerRejectReason(
    status: number,
    body: string | undefined,
): RelayerRejectReason {
    const text = (body ?? "").trim();
    for (const [s, prefix, reason] of PREFIXES) {
        if (status === s && text.startsWith(prefix)) return reason;
    }
    if (status === 402 && FEE_ASSET_REJECTED.test(text)) return "fee-asset-rejected";
    return "unknown";
}

/** Whether a response is the relayer's "broadcast, but no receipt" answer. */
export function isSubmitOutcomeUnknown(
    status: number | undefined,
    body: string | undefined,
): boolean {
    // Substring, not prefix: matched this way since before reasons were parsed,
    // and a proxy that wraps the text must still read as "may have landed".
    return status === 502 && (body ?? "").includes("outcome unknown");
}
