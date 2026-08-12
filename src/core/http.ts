// Shared HTTP: AbortController timeout, exponential-backoff retry with
// jitter, typed `NetworkError`, and a thin JSON layer on top.
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
            const method = (init?.method ?? "GET").toUpperCase();
            const idempotent = IDEMPOTENT.has(method);
            const timeoutMs =
                opts.timeoutMs ?? (idempotent ? DEFAULTS.timeoutMs : DEFAULTS.submitTimeoutMs);
            const allowRetry = idempotent || retryOnSubmit;

            // One key for every attempt of a logical request, so the server
            // can recognise the repeat.
            const request: RequestInit | undefined = idempotent
                ? init
                : { ...init, headers: { ...headersOf(init), "Idempotency-Key": idempotencyKey() } };

            /** Last non-ok body, kept across attempts so the final error has it. */
            let lastBody: string | undefined;
            let lastStatus: number | undefined;

            const attempt = async (): Promise<Response> => {
                let res: Response;
                try {
                    res = await withTimeout(
                        fetchImpl(url, request),
                        timeoutMs,
                        () => new TimeoutMarker(`request timeout (${timeoutMs}ms)`),
                    );
                } catch (err) {
                    if (err instanceof TimeoutMarker) {
                        throw new NetworkError(timeoutCode, url, err.message, {
                            cause: err,
                            context: { method },
                        });
                    }
                    throw new NetworkError(failureCode, url, "network error", {
                        cause: err,
                        context: { method },
                    });
                }

                if (res.status === 402 && onPaymentRequired) {
                    const handled = await onPaymentRequired(res, url, request);
                    if (handled) res = handled;
                }
                if (res.ok) return res;

                lastStatus = res.status;
                lastBody = await res.text().catch(() => undefined);
                throw new NetworkError(
                    failureCode,
                    url,
                    `HTTP ${res.status}${lastBody ? `: ${lastBody.slice(0, 200)}` : ""}`,
                    { status: res.status, body: lastBody, context: { method } },
                );
            };

            try {
                return await retry(attempt, {
                    retries: allowRetry ? retries : 0,
                    backoffMs,
                    shouldRetry: (err) => isTransient(err),
                    onRetry: ({ attempt: n, delayMs }) => {
                        log.debug("retrying request", {
                            url,
                            method,
                            attempt: n + 1,
                            delayMs,
                            status: lastStatus,
                        });
                        opts.onRetry?.({ url, method, attempt: n + 1, delayMs });
                    },
                });
            } catch (err) {
                // The final failure may be a timeout while an earlier attempt
                // carried a 5xx body worth reporting.
                if (err instanceof NetworkError && err.body === undefined && lastBody) {
                    throw new NetworkError(err.code, url, err.message, {
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

function isTransient(err: unknown): boolean {
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
}

export interface JsonClient {
    get<T>(path: string, opts?: JsonRequestOptions): Promise<T>;
    post<T>(path: string, body: unknown): Promise<T>;
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
            const init = o?.headers ? { headers: o.headers } : undefined;
            return json<T>(await http.fetch(target, init), target);
        },
        async post<T>(path: string, body: unknown): Promise<T> {
            const target = url(path);
            const res = await http.fetch(target, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
            });
            return json<T>(res, target);
        },
        async del(path: string, o?: JsonRequestOptions): Promise<void> {
            await http.fetch(url(path, o?.params), {
                method: "DELETE",
                ...(o?.headers ? { headers: o.headers } : {}),
            });
        },
    };
}
