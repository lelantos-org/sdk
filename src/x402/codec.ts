// x402 v2 HTTP transport: the protocol is carried in base64-JSON headers.
//
// Wire handling only; no wallet or policy logic.

import { X402PaymentError } from "../errors/x402.js";
import { unsupported } from "./requirements.js";
import {
    HEADER_PAYMENT_REQUIRED,
    HEADER_PAYMENT_RESPONSE,
    HEADER_PAYMENT_SIGNATURE,
    type PaymentPayload,
    type PaymentRequired,
    type SettleResponse,
    X402_VERSION,
} from "./types.js";

/**
 * Read the offer document from a 402's `PAYMENT-REQUIRED` header.
 *
 * @throws {X402PaymentError} `unsupported-requirements` when the header is
 * missing, has no `accepts[]`, or names another protocol version.
 */
export function readPaymentRequired(res: Response, url: string): PaymentRequired {
    const header = res.headers.get(HEADER_PAYMENT_REQUIRED);
    const decoded = header
        ? decodeBase64Json<PaymentRequired>(header, url, HEADER_PAYMENT_REQUIRED)
        : undefined;
    if (!decoded || !Array.isArray(decoded.accepts)) {
        throw new X402PaymentError(
            "unsupported-requirements",
            `x402: ${url} answered 402 without a usable ${HEADER_PAYMENT_REQUIRED} header`,
            { resource: url },
        );
    }
    if (decoded.x402Version !== X402_VERSION) {
        throw new X402PaymentError(
            "unsupported-requirements",
            `x402: ${url} offers protocol version ${String(decoded.x402Version)}; ` +
                `only ${X402_VERSION} is supported`,
            { resource: url },
        );
    }
    return decoded;
}

/**
 * Read the server's settlement receipt from a paid response. Absent or
 * malformed receipts yield `undefined`; a bad receipt must not fail a request
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

/**
 * Copy of `req` carrying the payment header.
 *
 * Takes a `Request` rather than a `RequestInit` so the retry reproduces the
 * original method, body and headers exactly.
 *
 * Consumes `req`'s body, so this must be the last use of it.
 */
export function withPaymentRequest(req: Request, payload: PaymentPayload): Request {
    const headers = new Headers(req.headers);
    headers.set(HEADER_PAYMENT_SIGNATURE, encodeBase64Json(payload));
    return new Request(req, { headers });
}

/**
 * Lowercased hostname of a resource URL, or the URL unchanged when it does not
 * parse.
 *
 * The unit of x402 identity: budgets are enforced and the ephemeral payer is
 * derived per host. Also used in logs, since a full URL would record the paid
 * request path.
 */
export function hostOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return url;
    }
}

// --- base64 JSON --------------------------------------------------------------
// `btoa`/`atob` are byte-oriented, so JSON is UTF-8 encoded first; `btoa`
// throws on non-Latin-1 characters.

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
