// JSON over HTTP: the layer every service client is built on.
//
// URL assembly, query-param merging, and `Response` → `T` decoding. The
// transport underneath — timeout, retry, backoff, redaction — is
// `./http.ts`, and this file deliberately does not reimplement any of it:
// `createJsonClient` composes a `createHttpClient` and forwards to it.
//
// Split from `./http.ts` because the two answer different questions. This one
// is about shape (what a route takes and returns); that one is about delivery
// (how many times to try, and when to give up). Every service client needs
// both, but `connect()` and the submitter need only the transport options.

import { type NetworkFailureCode, type NetworkTimeoutCode, WireFormatError } from "./errors.js";
import { createHttpClient, type HttpClient, type HttpClientOptions, redactUrl } from "./http.js";

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
