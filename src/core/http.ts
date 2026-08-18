// Shared HTTP: per-attempt AbortController timeout, exponential-backoff retry
// with jitter, typed `NetworkError`, and a thin JSON layer on top.
//
// Cancellation
// ------------
// Each attempt gets its own controller, aborted on timeout so a dead request
// releases its connection instead of running on beside the retry. A caller
// `signal` in `init` is honoured separately: it stops the retry loop rather
// than being retried as though it were a network flake, and the rejection is
// the caller's own abort reason.
//
// Every HTTP-speaking client in the SDK consumes these rather than
// reimplementing timeout/retry/backoff locally.
//
// Retry and idempotency
// ---------------------
// GET/HEAD retry freely. Non-idempotent requests (the submit endpoints)
// carry a client-generated `Idempotency-Key` and retry only when
// `retryOnSubmit` is on (the default).
//
// The key prevents a duplicate spend only if the relayer honors it. Where it
// does not, a relayer that broadcasts and then returns 5xx can be handed the
// same submission twice; set `retryOnSubmit: false` to surface transient 5xx
// to the caller instead.

import { getLogger } from "../log/logger.js";
import { retry, withTimeout } from "./async.js";
import {
    NetworkError,
    type NetworkFailureCode,
    type NetworkTimeoutCode,
    WireFormatError,
} from "./errors.js";
import { randomBytes } from "./random.js";

const log = getLogger("lelantos:http");

export interface HttpClientOptions {
    /** Per-attempt deadline. Default 15 000 for GET, 30 000 for POST. */
    timeoutMs?: number | undefined;
    /** Additional attempts after the first. Default 3. */
    retries?: number | undefined;
    /** Base backoff, doubled per attempt, ±25% jitter. Default 250. */
    backoffMs?: number | undefined;
    /** Defaults to bound `globalThis.fetch`. */
    fetchImpl?: typeof fetch | undefined;
    /**
     * Retry POST/PUT/PATCH/DELETE (which carry an `Idempotency-Key`).
     * Default true. See the module header before turning this off — or on.
     */
    retryOnSubmit?: boolean | undefined;
    /** Observability hook fired before each backoff. Must not throw. */
    onRetry?:
        | ((info: { url: string; method: string; attempt: number; delayMs: number }) => void)
        | undefined;
    /**
     * Invoked when the server returns 402, before `NetworkError` is thrown.
     * Return a `Response` to replace the 402 (its ok/non-ok status is then
     * honored) or null to fall through to the normal error path. Owns its
     * own retry semantics — the outer retry loop does NOT loop on the
     * returned response.
     */
    onPaymentRequired?: (
        res: Response,
        url: string,
        init: RequestInit | undefined,
    ) => Promise<Response | null>;
}

export interface HttpClient {
    fetch(url: string, init?: RequestInit): Promise<Response>;
}

const DEFAULTS = {
    timeoutMs: 15_000,
    submitTimeoutMs: 30_000,
    retries: 3,
    backoffMs: 250,
};

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS"]);
const RETRY_STATUS = new Set([408, 429]);

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

/**
 * Build `HttpClientOptions` from an optional `fetch`.
 *
 * The property is omitted rather than set to `undefined`, which
 * `exactOptionalPropertyTypes` rejects on an optional field.
 */
export function httpOptionsFor(fetchImpl?: typeof fetch | undefined): HttpClientOptions {
    return fetchImpl ? { fetchImpl } : {};
}

/** Failures surface as `NetworkError` with the caller-supplied code. */
export function createHttpClient(
    timeoutCode: NetworkTimeoutCode,
    failureCode: NetworkFailureCode,
    opts: HttpClientOptions = {},
): HttpClient {
    const retries = opts.retries ?? DEFAULTS.retries;
    const backoffMs = opts.backoffMs ?? DEFAULTS.backoffMs;
    const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const retryOnSubmit = opts.retryOnSubmit ?? true;
    const onPaymentRequired = opts.onPaymentRequired;

    return {
        async fetch(url, init) {
            // Errors and retry logs report `safeUrl`, never `url`: both reach
            // application logs, so a credential in a query string would be
            // copied verbatim into them.
            const safeUrl = redactUrl(url);
            const method = (init?.method ?? "GET").toUpperCase();
            const idempotent = IDEMPOTENT.has(method);
            const timeoutMs =
                opts.timeoutMs ?? (idempotent ? DEFAULTS.timeoutMs : DEFAULTS.submitTimeoutMs);
            const allowRetry = idempotent || retryOnSubmit;

            // Held separately, and deliberately not copied into `request`:
            // each attempt composes it with a fresh per-attempt controller,
            // and a shared signal there would be overwritten by the first one.
            const callerSignal = init?.signal ?? undefined;
            const request: RequestInit = { ...PRIVACY_REQUEST_DEFAULTS, ...init };
            delete request.signal;
            // One key for every attempt of a logical request, so the server
            // can recognise the repeat.
            if (!idempotent) {
                request.headers = {
                    ...headersOf(init),
                    "Idempotency-Key": idempotencyKey(),
                };
            }

            /** Last non-ok body, kept across attempts so the final error has it. */
            let lastBody: string | undefined;
            let lastStatus: number | undefined;

            const attempt = async (): Promise<Response> => {
                // A caller that already gave up must not have another attempt
                // issued on its behalf.
                if (callerSignal?.aborted) throw new AbortMarker(callerSignal.reason);

                // Rejecting the wrapper promise does not stop the request:
                // without this the connection stays open, and with retries a
                // single logical call can hold several live sockets at once —
                // for a submit, several copies of the same payload in flight.
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
                    // `AbortError` here, so ask the signal rather than the
                    // error which one happened. Conflating them retries a
                    // request the caller explicitly cancelled.
                    if (callerSignal?.aborted) throw new AbortMarker(callerSignal.reason);
                    if (err instanceof TimeoutMarker) {
                        throw new NetworkError(timeoutCode, safeUrl, err.message, {
                            cause: err,
                            context: { method },
                        });
                    }
                    throw new NetworkError(failureCode, safeUrl, "network error", {
                        cause: err,
                        context: { method },
                    });
                }

                if (res.status === 402 && onPaymentRequired) {
                    const handled = await onPaymentRequired(res, url, perAttempt);
                    if (handled) res = handled;
                }
                if (res.ok) return res;

                lastStatus = res.status;
                lastBody = await res.text().catch(() => undefined);
                // The body is exposed on `.body` and excluded from the
                // message, which reaches application logs verbatim; a relayer
                // or FMD 4xx may echo part of the submitted payload.
                throw new NetworkError(failureCode, safeUrl, `HTTP ${res.status}`, {
                    status: res.status,
                    body: lastBody,
                    context: { method },
                });
            };

            try {
                return await retry(attempt, {
                    retries: allowRetry ? retries : 0,
                    backoffMs,
                    ...(callerSignal ? { signal: callerSignal } : {}),
                    shouldRetry: (err) => isTransient(err),
                    onRetry: ({ attempt: n, delayMs }) => {
                        log.debug("retrying request", {
                            url: safeUrl,
                            method,
                            attempt: n + 1,
                            delayMs,
                            status: lastStatus,
                        });
                        opts.onRetry?.({ url: safeUrl, method, attempt: n + 1, delayMs });
                    },
                });
            } catch (err) {
                // Surface the caller's own reason, not an SDK error wrapping
                // it: `fetch` rejects with the reason, and so should this.
                if (err instanceof AbortMarker) throw err.reason;
                // The final failure may be a timeout while an earlier attempt
                // carried a 5xx body worth reporting.
                if (err instanceof NetworkError && err.body === undefined && lastBody) {
                    throw new NetworkError(err.code, safeUrl, err.message, {
                        cause: err.cause,
                        status: lastStatus,
                        body: lastBody,
                        context: err.context,
                    });
                }
                throw err;
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
 * reason itself, so a cancelled request neither retries nor arrives dressed up
 * as a network failure.
 */
class AbortMarker extends Error {
    constructor(readonly reason: unknown) {
        super("aborted");
    }
}

// Query params that carry a credential rather than a selector, matched
// case-insensitively. Anything unlisted is preserved, since the URL is what
// makes a network log readable.
const SECRET_PARAMS = new Set(["token", "fmdsecret", "detectionkey", "detectionkeyhex"]);
// Path prefixes whose FINAL segment is a bearer token, not a resource id.
const SECRET_PATH_PREFIXES = ["/v1/subscriptions/"];

/**
 * Strip credentials from a URL before it reaches a log line or an error
 * message. Host, path shape and param names are preserved, so the result
 * remains diagnosable.
 *
 * An unparseable URL yields `<unparseable url>` rather than passing through,
 * since a credential may sit somewhere this function does not inspect.
 */
export function redactUrl(raw: string): string {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        return "<unparseable url>";
    }

    for (const key of [...u.searchParams.keys()]) {
        if (SECRET_PARAMS.has(key.toLowerCase())) u.searchParams.set(key, "REDACTED");
    }
    for (const prefix of SECRET_PATH_PREFIXES) {
        if (u.pathname.startsWith(prefix) && u.pathname.length > prefix.length) {
            u.pathname = `${prefix}REDACTED`;
        }
    }
    return u.toString();
}

function isTransient(err: unknown): boolean {
    if (err instanceof AbortMarker) return false;
    if (!(err instanceof NetworkError)) return false;
    if (err.status === undefined) return true; // network failure or timeout
    return err.status >= 500 || RETRY_STATUS.has(err.status);
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

function idempotencyKey(): string {
    let s = "";
    for (const b of randomBytes(16)) s += b.toString(16).padStart(2, "0");
    return s;
}

// --- JSON layer --------------------------------------------------------------

export type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * `headers` keeps per-request credentials out of the URL: proxies and browser
 * history record a query string or path segment, but not a request header.
 */
export interface JsonRequestOptions {
    params?: QueryParams | undefined;
    headers?: Record<string, string> | undefined;
    /**
     * Overrides the `no-store` in {@link PRIVACY_REQUEST_DEFAULTS}.
     *
     * Only for routes that are global and identical for every caller, where
     * the URL discloses nothing about who asked. Anything scoped to a wallet
     * — notes, matches, subscriptions — must keep the default, since a cache
     * entry is a record of that request on the device and in any intermediary
     * that honors it.
     */
    cache?: RequestCache | undefined;
    /**
     * Cancels the request, and the retry loop with it.
     *
     * Honoured all the way down: `createHttpClient` composes it with the
     * per-attempt timeout controller, so an abort ends the in-flight request
     * rather than leaving the connection open beside a retry.
     */
    signal?: AbortSignal | undefined;
}

export interface JsonClient {
    get<T>(path: string, opts?: JsonRequestOptions): Promise<T>;
    post<T>(path: string, body: unknown, opts?: JsonRequestOptions): Promise<T>;
    del(path: string, opts?: JsonRequestOptions): Promise<void>;
    /** Escape hatch for non-JSON responses. */
    readonly raw: HttpClient;
}

export interface JsonClientOptions extends HttpClientOptions {
    /** Query params merged into every GET/DELETE (e.g. a pinned `chainId`). */
    defaultParams?: QueryParams | undefined;
}

/**
 * JSON-over-HTTP client. Sole `getJson`/`postJson` implementation; every
 * service client in the SDK is built on it.
 */
export function createJsonClient(
    baseUrl: string,
    codes: { timeout: NetworkTimeoutCode; failure: NetworkFailureCode },
    opts: JsonClientOptions = {},
): JsonClient {
    const base = baseUrl.replace(/\/$/, "");
    const http = createHttpClient(codes.timeout, codes.failure, opts);

    const url = (path: string, params?: QueryParams): string => {
        const u = new URL(base + path);
        for (const [k, v] of Object.entries({ ...opts.defaultParams, ...params })) {
            if (v !== undefined) u.searchParams.set(k, String(v));
        }
        return u.toString();
    };

    // `where` is redacted by every caller: this message reaches application
    // logs verbatim, and a route whose query string carries a detection key or
    // token would otherwise copy it there — the same reason `createHttpClient`
    // reports `safeUrl` rather than `url`.
    const json = async <T>(res: Response, where: string): Promise<T> => {
        try {
            return (await res.json()) as T;
        } catch (err) {
            throw new WireFormatError("$", `${where}: response is not valid JSON`, { cause: err });
        }
    };

    return {
        raw: http,
        async get<T>(path: string, o?: JsonRequestOptions): Promise<T> {
            const target = url(path, o?.params);
            const init: RequestInit = {
                ...(o?.headers ? { headers: o.headers } : {}),
                ...(o?.cache ? { cache: o.cache } : {}),
                ...(o?.signal ? { signal: o.signal } : {}),
            };
            return json<T>(await http.fetch(target, init), redactUrl(target));
        },
        async post<T>(path: string, body: unknown, o?: JsonRequestOptions): Promise<T> {
            const target = url(path, o?.params);
            const res = await http.fetch(target, {
                method: "POST",
                headers: { "content-type": "application/json", ...o?.headers },
                body: JSON.stringify(body),
                ...(o?.signal ? { signal: o.signal } : {}),
            });
            return json<T>(res, redactUrl(target));
        },
        async del(path: string, o?: JsonRequestOptions): Promise<void> {
            await http.fetch(url(path, o?.params), {
                method: "DELETE",
                ...(o?.headers ? { headers: o.headers } : {}),
                ...(o?.signal ? { signal: o.signal } : {}),
            });
        },
    };
}
