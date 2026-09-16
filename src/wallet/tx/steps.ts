// Submitting a proven spend and settling its notes.
//
// What a failed submit means for the notes it consumed (spent, reserved or
// untouched), the error the caller receives, and where a landed spend sits in
// its transaction. Used by `run-spend.ts` for every spend.

import { locateOperation } from "../../chain/operation.js";
import type { ChainReader } from "../../chain/port.js";
import type { Hex32 } from "../../core/brand.js";
import { errMessage, WalletError } from "../../errors/base.js";
import { NetworkError } from "../../errors/network.js";
import {
    RelayerRejectedError,
    type RelayerRejectReason,
    SpendOutcomeUnknownError,
} from "../../errors/spend.js";
import { getLogger } from "../../log/logger.js";
import {
    isSubmitOutcomeUnknown,
    parseRelayerRejectReason,
} from "../../services/relayer/reject-reason.js";
import { SPEND_RESERVATION_MS } from "../constants.js";

const log = getLogger("lelantos:wallet:spend");

/**
 * Whether a failed submit leaves it unknown whether the spend was accepted.
 *
 * An explicit rejection (bad payload, stale root) means nothing was spent and
 * the notes stay available. A submit without a definite answer may have
 * landed, and reselecting its notes leads to repeated duplicate rejections.
 *
 *   - no status: a timeout or dropped connection; the request may have been
 *     received and acted on.
 *   - any earlier attempt without a response: the transport resends a submit
 *     under the same `Idempotency-Key`, so a later definite answer (a 400, a
 *     429) does not rule out that the first copy landed.
 *   - 502 naming an unknown outcome: broadcast succeeded, no receipt arrived.
 *
 * A 409 is a definite answer about the nullifiers, classified separately by
 * {@link classifySubmitFailure}.
 *
 * @internal — exported for direct testing.
 */
export function outcomeUnknown(err: unknown): boolean {
    if (!(err instanceof NetworkError)) return false;
    if (err.status === undefined) return true;
    if (err.attempts.some((a) => a.status === undefined)) return true;
    return isSubmitOutcomeUnknown(err.status, err.body);
}

/**
 * A 409 reason whose notes are withheld from selection: the nullifiers are
 * spent, or held by another pending submission, or (stale estimate) the
 * refusal came after admission. Only a key collision says nothing about them.
 */
function reservesNotes(reason: RelayerRejectReason): boolean {
    return reason !== "idempotency-key-reused";
}

/** How {@link submitSpend} treats a failed submit. */
type SubmitFailure =
    | { kind: "unknown" }
    | {
          kind: "rejected";
          status: number;
          body: string;
          reason: RelayerRejectReason;
          /** Whether the spend's notes are withheld from selection. */
          reserve: boolean;
      }
    | { kind: "other" };

/**
 * What a failed submit means, as the error the caller receives, and what to do
 * to the spend's notes first.
 *
 *   - outcome unknown → `SpendOutcomeUnknownError`, notes reserved;
 *   - 409 → `RelayerRejectedError` with the parsed reason, notes reserved
 *     (except a reused idempotency key);
 *   - any other 4xx, or a 502 reporting a revert → `RelayerRejectedError`,
 *     notes untouched;
 *   - anything else (a 500/503, which stays a retryable `NetworkError`; a
 *     custom submitter's own error) → rethrown unchanged, notes untouched.
 *
 * @internal — exported for direct testing.
 */
export function classifySubmitFailure(err: unknown): SubmitFailure {
    if (outcomeUnknown(err)) return { kind: "unknown" };
    if (!(err instanceof NetworkError) || err.status === undefined) return { kind: "other" };
    const body = err.body ?? "";
    const reason = parseRelayerRejectReason(err.status, body);
    if (err.status === 409) {
        return { kind: "rejected", status: 409, body, reason, reserve: reservesNotes(reason) };
    }
    if ((err.status >= 400 && err.status < 500) || reason === "reverted") {
        return { kind: "rejected", status: err.status, body, reason, reserve: false };
    }
    return { kind: "other" };
}

/** What {@link submitSpend} does to a spend's notes. */
interface SpendSettlement {
    markSpent(ids: string[]): Promise<void>;
    /**
     * Withhold notes from selection after a spend with unknown outcome. Weaker
     * than `markSpent` and reversible; see `StoredNote.pendingSpendAt`.
     */
    markPendingSpend(ids: string[]): Promise<void>;
    /**
     * Sync the spent-nullifier set and reconcile local notes against it, after
     * the relayer refuses a spend because a nullifier is already spent.
     * Optional: without it the consumed notes stay offered until the next sync.
     */
    resyncSpent?(): Promise<void>;
}

/**
 * Submit a spend and record what it did to the notes it consumed.
 *
 * On success they are marked spent; on a definite failure they are untouched.
 * Otherwise they are reserved: withheld from the selector until the nullifier
 * feed resolves them or the reservation expires. See `StoredNote.pendingSpendAt`.
 *
 * A refusal because a nullifier is already spent triggers a spent-set resync
 * first, so the next selection no longer offers the consumed notes.
 */
export async function submitSpend<T>(
    ctx: SpendSettlement,
    spent: string[],
    submit: () => Promise<T>,
): Promise<T> {
    let result: T;
    try {
        result = await submit();
    } catch (err) {
        throw await settleFailedSubmit(ctx, spent, err);
    }
    await ctx.markSpent(spent);
    return result;
}

/** Apply {@link classifySubmitFailure} to the notes and build the error to throw. */
async function settleFailedSubmit(
    ctx: SpendSettlement,
    spent: string[],
    err: unknown,
): Promise<unknown> {
    const c = classifySubmitFailure(err);
    if (c.kind === "other") return err;

    const reserve = c.kind === "unknown" || c.reserve;
    const reservedUntil = new Date(Date.now() + SPEND_RESERVATION_MS);
    if (reserve) {
        // Leaves these notes unresolved, so a balance can drop without a
        // matching transaction; logged for diagnosis.
        log.warn("spend not confirmed; reserving its notes", {
            notes: spent.length,
            outcome: c.kind === "unknown" ? "unknown" : c.reason,
        });
        await ctx.markPendingSpend(spent);
    }
    const context = err instanceof WalletError ? err.context : undefined;

    if (c.kind === "unknown") {
        return new SpendOutcomeUnknownError(
            { reservedNoteIds: [...spent], reservedUntil },
            { cause: err, context },
        );
    }

    if (c.reason === "nullifier-spent" && ctx.resyncSpent) {
        // Best effort: the refusal is the answer the caller needs, and a
        // failed resync only means the next sync picks the spend up instead.
        await ctx.resyncSpent().catch((resyncErr: unknown) => {
            log.warn("spent-set resync after a nullifier-spent refusal failed", {
                error: errMessage(resyncErr),
            });
        });
    }
    return new RelayerRejectedError(
        {
            status: c.status,
            reason: c.reason,
            body: c.body,
            ...(reserve ? { reservedNoteIds: [...spent], reservedUntil } : {}),
        },
        { cause: err, context },
    );
}

/**
 * Attach where a landed spend sits in its transaction, when that can be read.
 *
 * A relayer may bundle several operations into one transaction, so the hash
 * alone does not identify this one. The receipt is read through the chain
 * adapter and matched locally against the spend's commitments, so the read RPC
 * learns the hash but not which operation belongs to this wallet.
 *
 * Never throws. The spend has already landed, so an adapter without log access,
 * a lagging read RPC, or an unexpected layout leaves `operation` absent.
 */
export async function withOperation<R extends { txHash: Hex32; commitments: readonly Hex32[] }>(
    chain: ChainReader,
    result: R,
): Promise<R> {
    if (!chain.txReceiptLogs) return result;
    try {
        const [logs, pool] = await Promise.all([
            chain.txReceiptLogs(result.txHash),
            chain.maspAddress(),
        ]);
        const operation = locateOperation(logs, pool, result.commitments);
        return operation ? { ...result, operation } : result;
    } catch (err) {
        log.debug("could not locate spend in its transaction", {
            error: errMessage(err),
        });
        return result;
    }
}
