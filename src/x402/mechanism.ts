// The contract every payment mechanism in this module implements.
//
// `SchemeNetworkClient` (see `./types.ts`) is `@x402/core`'s interface and is
// sufficient for external clients. `PayableSchemeClient` adds one method for
// the SDK's selector and remains structurally assignable to it, so it can be
// passed to `client.register(...)`.

import type { CircuitAmount } from "../core/brand.js";
import type { AssetInfo } from "../wallet/assets/index.js";
import type { PaymentPayloadContext, PaymentRequirements, SchemeNetworkClient } from "./types.js";

/**
 * What an offer would cost, in terms the wallet can reason about.
 *
 * Networks quote prices in their own units (MASP asset id and circuit units on
 * `shielded:*`; ERC-20 address and base units on `eip155:*`), which only the
 * mechanism can interpret. Normalising lets one budget cover both; the selector
 * never prices an offer itself.
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
 * `@x402/core` has no equivalent (its selector picks the first entry). Choosing
 * among several `accepts[]` entries requires it: an unsatisfiable offer falls
 * through to the next rather than aborting the request, and only the mechanism
 * can determine that.
 */
export interface PayableSchemeClient extends SchemeNetworkClient {
    /**
     * Price `paymentRequirements` **and judge whether this wallet can pay them**,
     * or reject with an `X402PaymentError` whose reason is
     * `unsupported-requirements`.
     *
     * Payability is the half the selector cannot determine for itself, and it is
     * a point-in-time answer rather than a promise: it reads the wallet as
     * currently synced — an unsynced wallet has nothing to spend and every offer
     * is refused — and may be stale by the time `createPaymentPayload` runs,
     * which is seconds later for a mechanism that proves.
     *
     * `context` is what `createPaymentPayload` will be given, so a mechanism
     * whose payer depends on the resource — the unshielded one derives a payer
     * address per host — judges the same payer it will later pay from.
     *
     * MUST NOT move funds or mutate state: the selector calls this on offers
     * it may discard.
     */
    quote(
        paymentRequirements: PaymentRequirements,
        context?: PaymentPayloadContext,
    ): Promise<PaymentQuote>;
}
