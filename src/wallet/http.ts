// Shared HTTP helper: AbortController timeout, exponential-backoff retry
// on 5xx + network errors, typed `NetworkError`.
//
// Canonical home for `HttpClientOptions` and `createHttpClient`. Every
// SDK HTTP-speaking client (`wallet/fmd-client.ts`, `relayer/client.ts`)
// MUST consume these — do not reimplement timeout/retry/backoff locally.

import { NetworkError } from "./errors.js";

type NetworkTimeoutCode = "RELAYER_TIMEOUT" | "FMD_TIMEOUT";
type NetworkFailureCode = "RELAYER_FAILED" | "FMD_FAILED";

export interface HttpClientOptions {
    /// Default 30 000.
    timeoutMs?: number;
    /// 5xx + network errors only (excludes 4xx). Default 2.
    retries?: number;
    /// Doubled on each retry. Default 250.
    backoffMs?: number;
    /// Defaults to bound `globalThis.fetch`.
    fetchImpl?: typeof fetch;
}

export interface HttpClient {
    fetch(url: string, init?: RequestInit): Promise<Response>;
}

const DEFAULTS: Required<Omit<HttpClientOptions, "fetchImpl">> = {
    timeoutMs: 30_000,
    retries: 2,
    backoffMs: 250,
};

/// Failures surface as `NetworkError` with the caller-supplied code.
export function createHttpClient(
    timeoutCode: NetworkTimeoutCode,
    failureCode: NetworkFailureCode,
    opts: HttpClientOptions = {},
): HttpClient {
    const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
    const retries = opts.retries ?? DEFAULTS.retries;
    const backoffMs = opts.backoffMs ?? DEFAULTS.backoffMs;
    const fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));

    async function attempt(url: string, init?: RequestInit): Promise<Response> {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(new Error("request timeout")), timeoutMs);
        try {
            return await fetchImpl(url, { ...init, signal: ctrl.signal });
        } finally {
            clearTimeout(t);
        }
    }

    return {
        async fetch(url, init) {
            let lastErr: unknown;
            for (let i = 0; i <= retries; i++) {
                try {
                    const res = await attempt(url, init);
                    if (res.ok) return res;
                    if (res.status >= 500 && i < retries) {
                        await sleep(backoffMs * 2 ** i);
                        continue;
                    }
                    const body = await res.text().catch(() => "");
                    throw new NetworkError(
                        failureCode,
                        url,
                        `HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
                        { status: res.status },
                    );
                } catch (err) {
                    lastErr = err;
                    if (err instanceof NetworkError) throw err;
                    const isAbort = (err as { name?: string })?.name === "AbortError";
                    if (i >= retries) {
                        throw new NetworkError(
                            isAbort ? timeoutCode : failureCode,
                            url,
                            isAbort ? `request timeout (${timeoutMs}ms)` : "network error",
                            { cause: err },
                        );
                    }
                    await sleep(backoffMs * 2 ** i);
                }
            }
            throw lastErr;
        },
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}
