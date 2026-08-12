// The contract every payment mechanism in this module implements.
//
// `SchemeNetworkClient` (see `./types.ts`) is `@x402/core`'s interface, and is
// all an external client needs. `PayableSchemeClient` adds one method for the
// SDK's own selector and stays structurally assignable to the former — an
// extra member is invisible to `client.register(...)`.

import type { CircuitAmount } from "../core/brand.js";
import type { AssetInfo } from "../wallet/assets.js";
import type { PaymentRequirements, SchemeNetworkClient } from "./types.js";

/**
 * What an offer would cost, in terms the wallet can reason about.
 *
 * Networks quote prices in their own units — a MASP asset id and circuit
 * units on `shielded:*`, an ERC-20 address and base units on `eip155:*` — and
 * only the mechanism knows how to read its own. Normalising here lets one
 * budget cover both; the selector never prices an offer itself.
 */
export interface PaymentQuote {
    /** Circuit units, rounded up. The denomination every `Wallet` method uses. */
    amount: CircuitAmount;
    /** The MASP asset the payment draws on. */
    asset: AssetInfo;
}

/**
 * A `SchemeNetworkClient` that can also price an offer without paying it.
 *
 * `@x402/core` has no equivalent — its selector picks the first entry and
 * fails hard — but choosing among several `accepts[]` entries needs one: an
 * offer this wallet cannot satisfy should fall through to the next rather
 * than abort the request, and only the mechanism can tell the difference.
 */
export interface PayableSchemeClient extends SchemeNetworkClient {
    /**
     * Price `paymentRequirements`, or reject with an `X402PaymentError`
     * whose reason is `unsupported-requirements`.
     *
     * MUST NOT move funds or mutate state: the selector calls this on offers
     * it may well discard.
     */
    quote(paymentRequirements: PaymentRequirements): Promise<PaymentQuote>;
}
