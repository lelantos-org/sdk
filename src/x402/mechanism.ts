// The contract every payment mechanism in this module implements.
//
// `SchemeNetworkClient` (see `./types.ts`) is `@x402/core`'s interface and is
// sufficient for external clients. `PayableSchemeClient` adds one method for
// the SDK's selector and remains structurally assignable to it, so it can be
// passed to `client.register(...)`.

import type { CircuitAmount } from "../core/brand.js";
import type { AssetInfo } from "../wallet/assets/index.js";
import type { PaymentRequirements, SchemeNetworkClient } from "./types.js";

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
     * Price `paymentRequirements`, or reject with an `X402PaymentError`
     * whose reason is `unsupported-requirements`.
     *
     * MUST NOT move funds or mutate state: the selector calls this on offers
     * it may discard.
     */
    quote(paymentRequirements: PaymentRequirements): Promise<PaymentQuote>;
}
