// Shared HTTP transport: per-attempt AbortController timeout,
// exponential-backoff retry with jitter, and typed `NetworkError`.
//
// The JSON layer lives in `./json-client.ts` and composes this transport.
//
// Cancellation
// ------------
// Each attempt gets its own controller, aborted on timeout so a dead request
// releases its connection instead of running on beside the retry. A caller
// `signal` in `init` is honoured separately: it stops the retry loop rather
// than being retried as a network failure, and the rejection is the caller's
// own abort reason.
//
// Every HTTP client in the SDK uses this transport for timeout/retry/backoff.
//
// Retry and idempotency
// ---------------------
// Retries key on whether the request is idempotent, not on its method. GET,
// HEAD and OPTIONS are idempotent by default; any request can declare itself
// so with `idempotent: true` (the relayer's fee estimates are POSTs that only
// read). Idempotent requests retry on no response, 408, 429 and any 5xx.
//
// Non-idempotent requests (the submit endpoints) carry one client-generated
// `Idempotency-Key` for every attempt and retry only where the server cannot
// have acted: no response, 429 and 503. A 500 or 502 on a submit may follow a broadcast (the relayer answers 502
// for "outcome unknown"), so it is surfaced rather than resent.
//
// A retried submit that first got no response may still have landed; the
// final error's `attempts` records that, and the spend path reserves the notes.

import { retry, withTimeout } from "../../core/async.js";
import { randomHex } from "../../core/random.js";
import {
    isTransientStatus,
    type NetworkAttempt,
    NetworkError,
    type NetworkFailureCode,
    type NetworkTimeoutCode,
} from "../../errors/network.js";
import { getLogger } from "../../log/logger.js";
import { redactUrl } from "./redact.js";

const log = getLogger("lelantos:http");

export interface HttpClientOptions {
    /**
     * Per-attempt deadline for idempotent requests, default 15 000. Also applies
     * to non-idempotent requests unless {@link HttpClientOptions.submitTimeoutMs} is set.
     */
    timeoutMs?: number | undefined;
    /**
     * Per-attempt deadline for non-idempotent requests — the submit endpoints,
     * which the relayer answers only once the transaction is mined. Takes
     * precedence over `timeoutMs` for them; default `timeoutMs`, else 30 000.
     *
     * Per chain in practice: a relayer on a slow-block chain, or one waiting to
     * fill a bundle, needs longer than one on an L2.
     */
    submitTimeoutMs?: number | undefined;
    /** Additional attempts after the first. Default 3. */
    retries?: number | undefined;
    /** Base backoff, doubled per attempt, ±25% jitter. Default 250. */
    backoffMs?: number | undefined;
    /** Defaults to bound `globalThis.fetch`. */
    fetch?: typeof fetch | undefined;
    /**
     * Added to every request, e.g. an API gateway key. A per-request header of
     * the same name wins.
     */
    headers?: Readonly<Record<string, string>> | undefined;
    /** Observability hook fired before each backoff. Must not throw. */
    onRetry?:
        | ((info: { url: string; method: string; attempt: number; delayMs: number }) => void)
        | undefined;
    /**
     * Invoked when the server returns 402, before `NetworkError` is thrown.
     * Return a `Response` to replace the 402 (its ok/non-ok status is then
     * honored) or null to fall through to the normal error path. Owns its
     * own retry semantics: the outer retry loop does NOT loop on the
     * returned response.
     */
    onPaymentRequired?: StatusHook;
}

/**
 * Handles a response with a particular status before it becomes an error.
 *
 * Returns a replacement `Response` (whose own status is then honoured) or
 * `null` to fall through to the error path. Runs once per attempt; the retry
 * loop does not repeat on the replacement.
 */
export type StatusHook = (
    res: Response,
    url: string,
    init: RequestInit | undefined,
) => Promise<Response | null>;

/** `RequestInit` plus the transport's own per-request switches. */
export interface HttpRequestInit extends RequestInit {
    /**
     * Whether repeating the request is harmless. Defaults to `true` for GET,
     * HEAD and OPTIONS and `false` otherwise. Decides the retry policy, the
     * timeout (`timeoutMs` vs `submitTimeoutMs`) and whether an
     * `Idempotency-Key` is attached. Never sent on the wire.
     */
    idempotent?: boolean | undefined;
}

export interface HttpClient {
    fetch(url: string, init?: HttpRequestInit): Promise<Response>;
}

const DEFAULTS = {
    timeoutMs: 15_000,
    submitTimeoutMs: 30_000,
    retries: 3,
    backoffMs: 250,
};

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * Statuses a submit retries on: the server refused before acting. A 500 or 502
 * may have followed a broadcast, so it is never resent.
 */
const SUBMIT_RETRY_STATUS = new Set([429, 503]);

/**
 * Request defaults applied to every SDK-originated request.
 *
 * Browser `fetch` otherwise sends the page origin as `Referer` and attaches
 * same-origin cookies. No Lelantos service reads either, and both are recorded
 * by intermediate proxies and access logs. Caller `init` overrides these.
 */
export const PRIVACY_REQUEST_DEFAULTS: Readonly<RequestInit> = Object.freeze({
    credentials: "omit",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    redirect: "follow",
});

/**
 * Bearer credential as request headers, for `JsonRequestOptions.headers`.
 *
 * Query params and path segments are recorded by proxies, CDNs and browser
 * history; request headers are not.
 */
export function bearerAuth(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
}

/** Failures surface as `NetworkError` with the caller-supplied code. */
export function createHttpClient(
    timeoutCode: NetworkTimeoutCode,
    failureCode: NetworkFailureCode,
    opts: HttpClientOptions = {},
): HttpClient {
    const retries = opts.retries ?? DEFAULTS.retries;
    const backoffMs = opts.backoffMs ?? DEFAULTS.backoffMs;
    const fetchImpl = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const baseHeaders = opts.headers ? { ...opts.headers } : undefined;

    return {
        async fetch(url, init) {
            // Errors and retry logs report `safeUrl`, never `url`: both reach
            // application logs, which must not receive query-string credentials.
            const safeUrl = redactUrl(url);
            const method = (init?.method ?? "GET").toUpperCase();
            const idempotent = init?.idempotent ?? IDEMPOTENT.has(method);
            const timeoutMs = idempotent
                ? (opts.timeoutMs ?? DEFAULTS.timeoutMs)
                : (opts.submitTimeoutMs ?? opts.timeoutMs ?? DEFAULTS.submitTimeoutMs);

            // Held separately, not copied into `request`: each attempt composes
            // it with a fresh per-attempt controller, which would overwrite a
            // shared signal.
            const callerSignal = init?.signal ?? undefined;
            const request: HttpRequestInit = { ...PRIVACY_REQUEST_DEFAULTS, ...init };
            delete request.signal;
            delete request.idempotent;
            if (baseHeaders || !idempotent) {
                request.headers = {
                    ...baseHeaders,
                    ...headersOf(init),
                    // One key for every attempt of a logical request, so the
                    // server can recognise the repeat.
                    ...(idempotent ? {} : { "Idempotency-Key": randomHex(16) }),
                };
            }

            // One entry per attempt, shared by every attempt's error, so the
            // final error reports the history while its own `status` and `body`
            // stay the final attempt's: a timeout after a 5xx must still read as
            // "no response", or a submit whose last attempt may have landed looks
            // definitely refused.
            const attempts: NetworkAttempt[] = [];

            const attempt = async (): Promise<Response> => {
                // No further attempt once the caller has aborted.
                if (callerSignal?.aborted) throw new AbortMarker(callerSignal.reason);

                // Rejecting the wrapper promise does not stop the request, so
                // the controller is aborted explicitly. Otherwise, with retries,
                // one logical call could hold several live sockets (for a
                // submit, several copies of the same payload in flight).
                const ctrl = new AbortController();
                const perAttempt: RequestInit = { ...request, signal: ctrl.signal };

                let res: Response;
                try {
                    res = await withTimeout(
                        fetchImpl(url, perAttempt),
                        timeoutMs,
                        () => new TimeoutMarker(`request timeout (${timeoutMs}ms)`),
                        callerSignal,
                    );
                } catch (err) {
                    ctrl.abort();
                    // The caller's abort and a timeout both surface as an
                    // `AbortError` here, so the signal, not the error, decides
                    // which occurred. A cancelled request must not be retried.
                    if (callerSignal?.aborted) throw new AbortMarker(callerSignal.reason);
                    attempts.push({});
                    const timedOut = err instanceof TimeoutMarker;
                    throw new NetworkError(
                        timedOut ? timeoutCode : failureCode,
                        safeUrl,
                        timedOut ? err.message : "network error",
                        { cause: err, attempts, context: { method } },
                    );
                }

                if (res.status === 402 && opts.onPaymentRequired) {
                    res = (await opts.onPaymentRequired(res, url, perAttempt)) ?? res;
                }
                if (res.ok) return res;

                const body = await res.text().catch(() => undefined);
                attempts.push({
                    status: res.status,
                    ...(body !== undefined ? { body } : {}),
                });
                // The body is exposed on `.body` and excluded from the
                // message, which reaches application logs verbatim; a relayer
                // or FMD 4xx may echo part of the submitted payload.
                throw new NetworkError(failureCode, safeUrl, `HTTP ${res.status}`, {
                    status: res.status,
                    body,
                    attempts,
                    context: { method },
                });
            };

            try {
                return await retry(attempt, {
                    retries,
                    backoffMs,
                    ...(callerSignal ? { signal: callerSignal } : {}),
                    shouldRetry: (err) => isTransient(err, idempotent),
                    onRetry: ({ attempt: n, delayMs }) => {
                        log.debug("retrying request", {
                            url: safeUrl,
                            method,
                            attempt: n + 1,
                            delayMs,
                            status: attempts.at(-1)?.status,
                        });
                        opts.onRetry?.({ url: safeUrl, method, attempt: n + 1, delayMs });
                    },
                });
            } catch (err) {
                // Surface the caller's own reason, not an SDK error wrapping
                // it: `fetch` rejects with the reason, and so should this.
                throw err instanceof AbortMarker ? err.reason : err;
            }
        },
    };
}

/** Internal marker so `withTimeout` rejections are distinguishable. */
class TimeoutMarker extends Error {}

/**
 * Internal marker carrying the caller's abort reason through the retry loop.
 *
 * `isTransient` treats it as non-retryable and the catch above rethrows the
 * reason itself, so a cancelled request neither retries nor surfaces as a
 * network failure.
 */
class AbortMarker extends Error {
    constructor(readonly reason: unknown) {
        super("aborted");
    }
}

function isTransient(err: unknown, idempotent: boolean): boolean {
    if (!(err instanceof NetworkError)) return false; // includes `AbortMarker`
    if (err.status === undefined) return true; // network failure or timeout
    return idempotent ? isTransientStatus(err.status) : SUBMIT_RETRY_STATUS.has(err.status);
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
    const h = init?.headers;
    if (!h) return {};
    if (Array.isArray(h)) return Object.fromEntries(h);
    if (typeof (h as Headers).forEach === "function" && !isPlainObject(h)) {
        const out: Record<string, string> = {};
        (h as Headers).forEach((v, k) => {
            out[k] = v;
        });
        return out;
    }
    return { ...(h as Record<string, string>) };
}

function isPlainObject(v: unknown): boolean {
    return Object.getPrototypeOf(v) === Object.prototype;
}
