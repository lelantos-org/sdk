// The contract every payment mechanism in this module implements.
//
// `SchemeNetworkClient` (see `./types.ts`) is `@x402/core`'s interface.
// `PayableSchemeClient` adds one method for the SDK's selector and remains
// structurally assignable to it, so it can be passed to `client.register(...)`.

import type { CircuitAmount } from "../core/brand.js";
import type { AssetInfo } from "../wallet/assets/index.js";
import type { PaymentPayloadContext, PaymentRequirements, SchemeNetworkClient } from "./types.js";

/**
 * What an offer would cost, in the wallet's units.
 *
 * Networks quote prices in their own units (see `PaymentRequirements`), which
 * only the mechanism can interpret. Normalising lets one budget cover every
 * network; the selector never prices an offer itself.
 */
export interface PaymentQuote {
    /** Circuit units, rounded up. The denomination every wallet method uses. */
    amount: CircuitAmount;
    /** The MASP asset the payment draws on. */
    asset: AssetInfo;
}

/**
 * A `SchemeNetworkClient` that can also price an offer without paying it.
 *
 * `@x402/core` has no equivalent (its selector picks the first entry). The
 * SDK's selector needs it to skip an offer this wallet cannot satisfy, which
 * only the mechanism can determine.
 */
export interface PayableSchemeClient extends SchemeNetworkClient {
    /**
     * Price `paymentRequirements` and judge whether this wallet can pay them,
     * or reject with an `X402PaymentError` whose reason is
     * `unsupported-requirements`.
     *
     * Payability is a point-in-time answer: it reads the wallet as currently
     * synced (an unsynced wallet has nothing to spend, so every offer is
     * refused) and may be stale by the time `createPaymentPayload` runs.
     *
     * `context` is what `createPaymentPayload` will be given, so a mechanism
     * whose payer depends on the resource (the unshielded one derives a payer
     * address per host) judges the payer it will pay from.
     *
     * Must not move funds or mutate state: the selector calls this on offers
     * it may discard.
     */
    quote(
        paymentRequirements: PaymentRequirements,
        context?: PaymentPayloadContext,
    ): Promise<PaymentQuote>;
}
