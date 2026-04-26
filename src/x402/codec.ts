// x402 v2 HTTP transport: the protocol travels in base64-JSON headers.
//
// Isolated from the payment logic because it is pure wire handling — no
// wallet, no policy — and because getting the encoding wrong fails in ways
// that look like a server bug.

import { X402PaymentError } from "../core/errors.js";
import { unsupported } from "./requirements.js";
import {
    HEADER_PAYMENT_REQUIRED,
    HEADER_PAYMENT_RESPONSE,
    HEADER_PAYMENT_SIGNATURE,
    type PaymentPayload,
    type PaymentRequired,
    type SettleResponse,
} from "./types.js";

/**
 * Read the offer document from a 402.
 *
 * v2 carries it in the `PAYMENT-REQUIRED` header. A body-carried document is
 * accepted too: v1 put it there and many servers still do, so the fallback
 * avoids reporting "no accepts[]" for an otherwise well-formed 402.
 */
export async function readPaymentRequired(res: Response, url: string): Promise<PaymentRequired> {
    const header = res.headers.get(HEADER_PAYMENT_REQUIRED);
    if (header) {
        const decoded = decodeBase64Json<PaymentRequired>(header, url, HEADER_PAYMENT_REQUIRED);
        if (Array.isArray(decoded.accepts)) return decoded;
    }

    const body = await res
        .clone()
        .json()
        .catch(() => undefined);
    if (body && Array.isArray((body as PaymentRequired).accepts)) {
        return body as PaymentRequired;
    }

    throw new X402PaymentError(
        "unsupported-requirements",
        `x402: ${url} answered 402 without a usable ${HEADER_PAYMENT_REQUIRED} header ` +
            "or `accepts[]` body",
        { resource: url },
    );
}

/**
 * Read the server's settlement receipt from a paid response. Absent or
 * malformed both yield `undefined` — a bad receipt must never fail a request
 * that has already been paid for.
 */
export function readSettlement(res: Response): SettleResponse | undefined {
    const header = res.headers.get(HEADER_PAYMENT_RESPONSE);
    if (!header) return undefined;
    try {
        return decodeBase64Json<SettleResponse>(header, res.url, HEADER_PAYMENT_RESPONSE);
    } catch {
        return undefined;
    }
}

/** Copy `init`, adding the payment. Never mutates the caller's object. */
export function withPaymentHeader(
    init: RequestInit | undefined,
    payload: PaymentPayload,
): RequestInit {
    const headers = new Headers(init?.headers);
    headers.set(HEADER_PAYMENT_SIGNATURE, encodeBase64Json(payload));
    return { ...init, headers };
}

/** The URL a `fetch` argument refers to, in any of its three forms. */
export function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    return input.url;
}

// --- base64 JSON --------------------------------------------------------------
// `btoa`/`atob` are byte-oriented, so JSON is UTF-8 encoded first — a
// resource description with a non-ASCII character would otherwise throw.

export function encodeBase64Json(value: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

export function decodeBase64Json<T>(encoded: string, url: string, what: string): T {
    try {
        const binary = atob(encoded.trim());
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch (err) {
        throw unsupported(what, `header from ${url} is not valid base64 JSON`, { cause: err });
    }
}
