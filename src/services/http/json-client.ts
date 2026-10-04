// JSON over HTTP, the layer every service client is built on: URL assembly,
// query-param merging and `Response` → `T` decoding. Delivery (timeout, retry,
// backoff, redaction) is `createHttpClient` in `./client.ts`.

import {
    type NetworkFailureCode,
    type NetworkTimeoutCode,
    WireFormatError,
} from "../../errors/network.js";
import { createHttpClient, type HttpClient, type HttpClientOptions } from "./client.js";
import { redactUrl } from "./redact.js";

export type QueryParams = Record<string, string | number | boolean | undefined>;

/** `headers` keeps per-request credentials out of the URL; see `bearerAuth`. */
export interface JsonRequestOptions {
    params?: QueryParams | undefined;
    headers?: Record<string, string> | undefined;
    /**
     * Overrides the `no-store` in {@link PRIVACY_REQUEST_DEFAULTS} on GET.
     * Only for global routes identical for every caller, where the URL
     * discloses nothing about who asked. Wallet-scoped routes (notes, matches,
     * subscriptions) must keep the default: a cache entry records the request
     * on the device and in any intermediary that honors it.
     */
    cache?: RequestCache | undefined;
    /** Cancels the in-flight request and the retry loop. */
    signal?: AbortSignal | undefined;
    /**
     * Declares a non-GET request safe to repeat, so it retries on 5xx like a
     * read. See `HttpRequestInit.idempotent`.
     */
    idempotent?: boolean | undefined;
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
 * JSON-over-HTTP client. Transport failures surface as `NetworkError` with
 * `codes`; a body that is not valid JSON raises `WireFormatError`.
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

    // Every caller redacts `where`: the message reaches application logs
    // verbatim, and a query string may carry a detection key or token.
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
            const init = { ...headersAndSignal(o), ...(o?.cache ? { cache: o.cache } : {}) };
            return json<T>(await http.fetch(target, init), redactUrl(target));
        },
        async post<T>(path: string, body: unknown, o?: JsonRequestOptions): Promise<T> {
            const target = url(path, o?.params);
            const res = await http.fetch(target, {
                ...headersAndSignal(o),
                method: "POST",
                headers: { "content-type": "application/json", ...o?.headers },
                body: JSON.stringify(body),
                ...(o?.idempotent !== undefined ? { idempotent: o.idempotent } : {}),
            });
            return json<T>(res, redactUrl(target));
        },
        async del(path: string, o?: JsonRequestOptions): Promise<void> {
            await http.fetch(url(path, o?.params), { ...headersAndSignal(o), method: "DELETE" });
        },
    };
}

/**
 * The `headers` and `signal` that `o` sets, omitting unset ones: an explicit
 * `undefined` is not a valid `RequestInit` value under `exactOptionalPropertyTypes`.
 */
function headersAndSignal(o: JsonRequestOptions | undefined): RequestInit {
    return {
        ...(o?.headers ? { headers: o.headers } : {}),
        ...(o?.signal ? { signal: o.signal } : {}),
    };
}
