// x402 payment errors.

import { WalletError, type WalletErrorOptions } from "./base.js";

/**
 * Why an x402 payment was refused. Every value means *no funds moved* —
 * the checks all run before `wallet.transfer`/`wallet.withdraw` is called.
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
 * An x402 payment could not be made. Callers branch on `reason`: a
 * `budget-exceeded` is a policy stop the agent should surface to its
 * operator, while `no-acceptable-requirements` means this server cannot be
 * paid by this wallet.
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
        // Exposed as a field and excluded from `context`, which error
        // reporters serialise in full. The resource URL identifies the paid
        // APIs this wallet calls.
        this.resource = opts?.resource;
    }
}
