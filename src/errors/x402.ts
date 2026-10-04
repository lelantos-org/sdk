// x402 payment errors.

import { WalletError, type WalletErrorOptions } from "./base.js";

/**
 * Why an x402 payment was refused. Every value except `payment-rejected` means no funds
 * moved: those checks run before `wallet.transfer`/`wallet.withdraw` is called.
 */
export type X402RefusalReason =
    /** Cumulative spend for this asset would exceed `budget.total`. */
    | "budget-exceeded"
    /** This single payment exceeds `budget.perRequest`. */
    | "per-request-limit"
    /** Request host is not in `allowHosts`. */
    | "host-not-allowed"
    /** Nothing in `accepts[]` is payable by this wallet. */
    | "no-acceptable-requirements"
    /** Requirements are malformed, or name a chain/pool this wallet is not on. */
    | "unsupported-requirements"
    /** Server returned 402 again after a payment was attached. */
    | "payment-rejected";

/**
 * An x402 payment was refused. Callers branch on `reason`: `budget-exceeded` is a policy stop
 * the agent should surface to its operator, while `no-acceptable-requirements` means this
 * server cannot be paid by this wallet.
 */
export class X402PaymentError extends WalletError<"X402_PAYMENT"> {
    readonly reason: X402RefusalReason;
    /** Resource URL the payment was for, when known. */
    readonly resource?: string | undefined;

    constructor(
        reason: X402RefusalReason,
        message: string,
        opts?: WalletErrorOptions & { resource?: string | undefined },
    ) {
        super("X402_PAYMENT", message, opts);
        this.name = "X402PaymentError";
        this.reason = reason;
        // A field, never `context`, which error reporters serialise in full: the resource URL
        // identifies the paid APIs this wallet calls.
        this.resource = opts?.resource;
    }
}
