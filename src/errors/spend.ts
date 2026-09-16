// Submission errors: the relayer's refusal, an unknown outcome, a passed deadline, a stale quote.

import { WalletError, type WalletErrorOptions } from "./base.js";

/**
 * Why the relayer refused a submission, parsed from its response in one place
 * (`services/relayer/reject-reason.ts`).
 *
 *   * `nullifier-spent`: a note this spend consumes is already spent on chain.
 *     The wallet resyncs its spent set before throwing.
 *   * `nullifier-in-flight`: another submission of the same note is still
 *     pending at the relayer. Retryable.
 *   * `idempotency-key-reused`: the request key collided with a different
 *     submission. Retryable (a retry draws a fresh key).
 *   * `stale-estimate`: the fee quote the spend was priced against has moved.
 *     Retryable (a retry re-quotes).
 *   * `fee-missing` / `fee-too-low` / `fee-asset-rejected`: the shielded fee
 *     note is absent, short, or in an asset the relayer will not take.
 *   * `contract-rejected`: a pool guard refused the payload in pre-flight; no
 *     gas was spent.
 *   * `reverted`: the transaction reached the chain and reverted.
 *   * `bad-request`: the payload is malformed.
 *   * `unknown-chain`: the relayer does not serve this chain.
 *   * `unavailable`: the relayer cannot serve this chain right now. Retryable.
 *   * `internal`: the relayer failed. Retryable.
 *   * `unknown`: a response this SDK version does not recognise.
 */
export type RelayerRejectReason =
    | "nullifier-spent"
    | "nullifier-in-flight"
    | "idempotency-key-reused"
    | "stale-estimate"
    | "fee-missing"
    | "fee-too-low"
    | "fee-asset-rejected"
    | "contract-rejected"
    | "reverted"
    | "bad-request"
    | "unknown-chain"
    | "unavailable"
    | "internal"
    | "unknown";

/** Reasons a retry of the same call may succeed without user action. */
const RETRYABLE_REASONS: ReadonlySet<RelayerRejectReason> = new Set([
    "nullifier-in-flight",
    "idempotency-key-reused",
    "stale-estimate",
    "unavailable",
    "internal",
]);

/**
 * The relayer answered a submission with a definite refusal.
 *
 * `reason` is the machine-readable cause; `body` is the relayer's own text,
 * kept off the message because it can echo parts of the submitted payload.
 * `retryable` follows the reason (see {@link RelayerRejectReason}).
 */
export class RelayerRejectedError extends WalletError<"RELAYER_REJECTED"> {
    readonly status: number;
    readonly reason: RelayerRejectReason;
    /** The relayer's response text, verbatim. */
    readonly body: string;
    /**
     * Notes this wallet withheld from selection because the refusal leaves
     * their state in doubt (`nullifier-*`, `stale-estimate`). Empty otherwise.
     */
    readonly reservedNoteIds: readonly string[];
    /** When {@link RelayerRejectedError.reservedNoteIds} are released, if any were reserved. */
    readonly reservedUntil?: Date | undefined;

    constructor(
        args: {
            status: number;
            reason: RelayerRejectReason;
            body: string;
            reservedNoteIds?: readonly string[] | undefined;
            reservedUntil?: Date | undefined;
        },
        opts?: WalletErrorOptions,
    ) {
        super("RELAYER_REJECTED", `relayer rejected the submission: ${args.reason}`, {
            ...opts,
            retryable: RETRYABLE_REASONS.has(args.reason),
        });
        this.name = "RelayerRejectedError";
        this.status = args.status;
        this.reason = args.reason;
        this.body = args.body;
        this.reservedNoteIds = args.reservedNoteIds ?? [];
        if (args.reservedUntil !== undefined) this.reservedUntil = args.reservedUntil;
    }
}

/**
 * A spend was submitted and no definite answer came back: a timeout, a
 * dropped connection, or the relayer broadcasting without seeing a receipt.
 * It may have landed.
 *
 * Its notes are reserved (withheld from selection) until the nullifier feed
 * shows them spent or `reservedUntil` passes, so a retry does not reselect
 * them and get refused as a double spend. Check the chain, or `sync()` after a
 * while, before sending again. Not retryable as-is.
 */
export class SpendOutcomeUnknownError extends WalletError<"SPEND_OUTCOME_UNKNOWN"> {
    readonly reservedNoteIds: readonly string[];
    readonly reservedUntil: Date;
    /** Hash of the broadcast, when the relayer reported one. */
    readonly txHash?: string | undefined;

    constructor(
        args: {
            reservedNoteIds: readonly string[];
            reservedUntil: Date;
            txHash?: string | undefined;
        },
        opts?: WalletErrorOptions,
    ) {
        super(
            "SPEND_OUTCOME_UNKNOWN",
            "spend submitted but its outcome is unknown; its notes are reserved until the chain " +
                "shows them spent or the reservation expires, so sync and check before resending",
            opts,
        );
        this.name = "SpendOutcomeUnknownError";
        this.reservedNoteIds = args.reservedNoteIds;
        this.reservedUntil = args.reservedUntil;
        if (args.txHash !== undefined) this.txHash = args.txHash;
    }
}

/** The operation's `deadline` (unix seconds) passed before it could be sent. Nothing was sent. */
export class DeadlinePassedError extends WalletError<"DEADLINE_PASSED"> {
    readonly deadline: bigint;
    constructor(deadline: bigint, opts?: WalletErrorOptions) {
        super(
            "DEADLINE_PASSED",
            "the operation's deadline has already passed; pass a later deadline (or a fresh quote)",
            opts,
        );
        this.name = "DeadlinePassedError";
        this.deadline = deadline;
    }
}

/**
 * A quote no longer matches what the pool would do now: a yield index or the relayer's flush fee
 * moved since it was made. The quote itself is intact (a tampered or malformed quote is
 * `INVALID_ARGUMENT`). Nothing was sent. Retryable: request a new quote and run it.
 */
export class QuoteStaleError extends WalletError<"QUOTE_STALE"> {
    /** The quoted figures the current state no longer reproduces, e.g. `["gross", "net"]`. */
    readonly fields: readonly string[];
    constructor(args: { fields: readonly string[] }, opts?: WalletErrorOptions) {
        super(
            "QUOTE_STALE",
            "the quote is stale: rates or fees moved since it was made; request a new quote",
            { ...opts, retryable: true },
        );
        this.name = "QuoteStaleError";
        this.fields = [...args.fields];
    }
}
