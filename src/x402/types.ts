// x402 v2 wire types, declared structurally.
//
// These mirror `@x402/core`'s Zod-inferred types field for field, but are
// declared here rather than imported so the SDK type-checks, builds, and
// ships with no `@x402/*` package installed. Anything this module returns is
// assignable to the matching `@x402/core` interface, so
// `x402Client.register(network, shieldedExact(wallet))` works:
//
//   import { x402Client } from "@x402/core";
//   client.register(`shielded:${chainId}`, shieldedExact(wallet));
//
// Spec: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md

/** Describes the thing being paid for. Server-authored. */
export interface ResourceInfo {
    url: string;
    description?: string;
    mimeType?: string;
    serviceName?: string;
    tags?: string[];
    iconUrl?: string;
}

/**
 * One payment option offered by the server. `scheme` and `network` together
 * pick the mechanism; `@x402/core` validates `network` only for CAIP-2 shape
 * (`min(3)` and contains `":"`), which is why `shielded:<chainId>` is legal.
 *
 * `amount` and `asset` are denominated by the network, not by x402 — for
 * `shielded:*` that means circuit units and a MASP asset id, and for
 * `eip155:*` it means ERC-20 base units and a token address.
 */
export interface PaymentRequirements {
    scheme: string;
    network: string;
    amount: string;
    asset: string;
    payTo: string;
    maxTimeoutSeconds: number;
    extra?: Record<string, unknown>;
}

/** Body of the base64 `PAYMENT-REQUIRED` header on a 402 response. */
export interface PaymentRequired {
    x402Version: number;
    error?: string;
    resource?: ResourceInfo;
    accepts: PaymentRequirements[];
    extensions?: Record<string, unknown>;
}

/** Body of the base64 `PAYMENT-SIGNATURE` header on the paid retry. */
export interface PaymentPayload {
    x402Version: number;
    resource?: ResourceInfo;
    /** The `accepts[]` entry this payment answers, echoed verbatim. */
    accepted: PaymentRequirements;
    payload: Record<string, unknown>;
    extensions?: Record<string, unknown>;
}

/** Body of the base64 `PAYMENT-RESPONSE` header on the 200. */
export interface SettleResponse {
    success: boolean;
    transaction: string;
    network: string;
    errorReason?: string;
    payer?: string;
    amount?: string;
}

/** What a mechanism returns; the client wraps it into a {@link PaymentPayload}. */
export interface PaymentPayloadResult {
    x402Version: number;
    payload: Record<string, unknown>;
    extensions?: Record<string, unknown>;
}

export interface PaymentPayloadContext {
    extensions?: Record<string, unknown>;
}

/**
 * Structural match for `@x402/core`'s `SchemeNetworkClient`. Implementations
 * are registered against one `(scheme, network)` pair.
 */
export interface SchemeNetworkClient {
    readonly scheme: string;
    createPaymentPayload(
        x402Version: number,
        paymentRequirements: PaymentRequirements,
        context?: PaymentPayloadContext,
    ): Promise<PaymentPayloadResult>;
}

/** Header names, v2. Case-insensitive on the wire; these are the canonical spellings. */
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT_SIGNATURE = "PAYMENT-SIGNATURE";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

/** Protocol version this module speaks. */
export const X402_VERSION = 2;
