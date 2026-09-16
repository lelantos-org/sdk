// Network / HTTP and wire-format errors.

import { WalletError, type WalletErrorOptions } from "./base.js";

export type NetworkTimeoutCode = "RELAYER_TIMEOUT" | "FMD_TIMEOUT" | "QUOTER_TIMEOUT";
export type NetworkFailureCode = "RELAYER_FAILED" | "FMD_FAILED" | "QUOTER_FAILED";
export type NetworkErrorCode = NetworkTimeoutCode | NetworkFailureCode;

/**
 * HTTP failure after retries, or deadline expired. `cause` carries the
 * underlying network error.
 *
 * Generic in its code so {@link AnyWalletError} can list one variant per code:
 * a union-typed `code` is not assignable to `{ code: "RELAYER_TIMEOUT" }`, so
 * the `Extract` behind {@link WalletErrorOf} would discard the class and every
 * network code would narrow to `never`. The parameter defaults to the full
 * union, so `NetworkError` still names the class in an annotation.
 */
export class NetworkError<C extends NetworkErrorCode = NetworkErrorCode> extends WalletError<C> {
    readonly url: string;
    /**
     * HTTP status of the final attempt; absent when that attempt got no response (a timeout or
     * dropped connection). Never copied from an earlier attempt: see {@link NetworkError.attempts}.
     */
    readonly status?: number | undefined;
    /** Response body of the final attempt, when it got a non-ok response. */
    readonly body?: string | undefined;
    /**
     * Every attempt of the logical request, oldest first; the last entry is the one `status` and
     * `body` describe. A single entry when the request was not retried.
     *
     * An entry without `status` received no response, so for a non-idempotent request (a submit)
     * the server may have acted on it even though a later attempt was answered.
     */
    readonly attempts: readonly NetworkAttempt[];

    constructor(
        code: C,
        url: string,
        message: string,
        opts?: WalletErrorOptions & {
            status?: number | undefined;
            body?: string | undefined;
            attempts?: readonly NetworkAttempt[] | undefined;
        },
    ) {
        super(code, `${message} (${url})`, {
            ...opts,
            retryable: isRetryableNetworkFailure(code, opts?.status),
        });
        this.name = "NetworkError";
        this.url = url;
        this.status = opts?.status;
        this.body = opts?.body;
        this.attempts = opts?.attempts ?? [
            {
                ...(opts?.status !== undefined ? { status: opts.status } : {}),
                ...(opts?.body !== undefined ? { body: opts.body } : {}),
            },
        ];
        this.context.url ??= url;
    }
}

/** Whether an HTTP failure status may clear up on its own: 408, 429 or any 5xx. */
export function isTransientStatus(status: number): boolean {
    return status >= 500 || status === 408 || status === 429;
}

/**
 * Timeouts, no response and transient statuses may clear up on their own. For a
 * non-idempotent request the spend path decides separately whether the attempt
 * may have landed; see `SpendOutcomeUnknownError`.
 */
function isRetryableNetworkFailure(code: NetworkErrorCode, status: number | undefined): boolean {
    return code.endsWith("_TIMEOUT") || status === undefined || isTransientStatus(status);
}

/** One attempt of a request that ended in a {@link NetworkError}. */
export interface NetworkAttempt {
    /** HTTP status; absent when no response arrived (timeout or network failure). */
    status?: number | undefined;
    /** Response body of a non-ok response. */
    body?: string | undefined;
}

/**
 * The local Merkle tree does not match the root the pool accepts, even after
 * resyncing and rebuilding it from leaf 0: the commitment feed is serving
 * leaves that do not reconcile with the root it reports.
 *
 * Checked before proving, so nothing was spent. Retryable: a lagging or
 * repaired feed resolves it.
 */
export class TreeOutOfSyncError extends WalletError<"TREE_OUT_OF_SYNC"> {
    /** Root of the locally rebuilt tree, as a decimal field element. */
    readonly localRoot: string;
    /** Root the commitment feed reports, as a decimal field element. */
    readonly mirrorRoot: string;
    constructor(
        args: { localRoot: bigint | string; mirrorRoot: bigint | string },
        opts?: WalletErrorOptions,
    ) {
        super(
            "TREE_OUT_OF_SYNC",
            "local Merkle root does not match the chain after resyncing and rebuilding the tree, " +
                "and the pool does not recognise it either; any proof built now would be " +
                "rejected, so retry once the commitment feed catches up",
            { ...opts, retryable: true },
        );
        this.name = "TreeOutOfSyncError";
        this.localRoot = args.localRoot.toString();
        this.mirrorRoot = args.mirrorRoot.toString();
    }
}

/** A server response did not match the documented wire contract. */
export class WireFormatError extends WalletError<"WIRE_FORMAT"> {
    /** JSON path of the offending value, e.g. `$.pathElements[3][1]`. */
    readonly path: string;
    constructor(path: string, message: string, opts?: WalletErrorOptions) {
        super("WIRE_FORMAT", `${message} at ${path}`, opts);
        this.name = "WireFormatError";
        this.path = path;
    }
}
