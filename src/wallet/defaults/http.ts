// `HttpOptions` (one set for the whole wallet) → the transport options of one service client.

import { getLogger } from "../../log/logger.js";
import type { HttpClientOptions } from "../../services/http/client.js";
import type { HttpOptions, RetryInfo } from "../connect/options.js";

const log = getLogger("lelantos:wallet:http");

/**
 * Transport options for `service`'s client.
 *
 * `onRetry` gains the service name, and a throw from it is logged and swallowed so an
 * observability hook cannot fail a request. `submitTimeoutMs` falls back to `presetSubmitTimeoutMs`.
 */
export function serviceHttpOptions(
    http: HttpOptions | undefined,
    service: RetryInfo["service"],
    presetSubmitTimeoutMs?: number | undefined,
): HttpClientOptions {
    const out: HttpClientOptions = {};
    if (http?.fetch) out.fetch = http.fetch;
    if (http?.timeoutMs !== undefined) out.timeoutMs = http.timeoutMs;
    const submit = http?.submitTimeoutMs ?? presetSubmitTimeoutMs;
    if (submit !== undefined) out.submitTimeoutMs = submit;
    if (http?.retries !== undefined) out.retries = http.retries;
    if (http?.headers) out.headers = http.headers;
    const onRetry = http?.onRetry;
    if (onRetry) {
        out.onRetry = (info) => {
            try {
                onRetry({ service, ...info });
            } catch (err) {
                log.warn("onRetry threw; ignored", { service, err });
            }
        };
    }
    return out;
}

/** Problems with `http`, for `WalletConfigError.missing`. Empty when valid. */
export function httpOptionProblems(http: unknown): string[] {
    if (http === undefined) return [];
    if (typeof http !== "object" || http === null) return ["`http` must be an object"];
    const h = http as Record<string, unknown>;
    const out: string[] = [];
    for (const key of ["timeoutMs", "submitTimeoutMs"] as const) {
        const v = h[key];
        if (v !== undefined && !(typeof v === "number" && Number.isFinite(v) && v > 0)) {
            out.push(`\`http.${key}\` (a positive number of milliseconds)`);
        }
    }
    if (h.retries !== undefined && !(Number.isInteger(h.retries) && (h.retries as number) >= 0)) {
        out.push("`http.retries` (a non-negative integer)");
    }
    for (const key of ["fetch", "onRetry"] as const) {
        if (h[key] !== undefined && typeof h[key] !== "function") {
            out.push(`\`http.${key}\` (a function)`);
        }
    }
    if (h.headers !== undefined) {
        const headers = h.headers;
        if (
            typeof headers !== "object" ||
            headers === null ||
            Object.values(headers).some((v) => typeof v !== "string")
        ) {
            out.push("`http.headers` (a record of strings)");
        }
    }
    return out;
}
