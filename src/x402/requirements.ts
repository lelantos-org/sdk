// Shared vocabulary for reading a server's `PaymentRequirements`.
//
// Every check answers "can this wallet pay this offer?", and every failure is
// `unsupported-requirements`, which the selector treats as "skip to the next
// `accepts[]` entry". They live together because a refusal thrown with any
// other reason aborts the whole request.

import { InvalidArgumentError, X402PaymentError } from "../core/errors.js";

/**
 * "This wallet cannot pay this offer" — recoverable, the caller should try
 * the next one. `scope` names the mechanism for the message prefix.
 *
 * Returns the error rather than throwing so call sites read as
 * `throw unsupported(...)`, which keeps them visibly terminal.
 */
export function unsupported(
    scope: string,
    message: string,
    opts?: { cause?: unknown },
): X402PaymentError {
    return new X402PaymentError("unsupported-requirements", `x402 ${scope}: ${message}`, opts);
}

/** A CAIP-2 `namespace:reference` identifier, split. */
export interface Caip2 {
    namespace: string;
    reference: string;
}

/**
 * Split a CAIP-2 network id. `@x402/core` validates only that the string is
 * ≥3 chars and contains a colon; everything beyond that is checked here.
 */
export function parseCaip2(network: string): Caip2 {
    const i = network.indexOf(":");
    if (i < 0) return { namespace: "", reference: network };
    return { namespace: network.slice(0, i), reference: network.slice(i + 1) };
}

/**
 * Require an offer to be on `namespace:<this wallet's chain>`.
 *
 * Both halves are worth distinguishing in the message: a wrong namespace
 * means the offer was meant for a different kind of mechanism, while a wrong
 * reference means the right mechanism on a chain we have no bridge to.
 */
export function requireNetwork(
    scope: string,
    network: string,
    expected: { namespace: string; chainId: bigint },
): void {
    const { namespace, reference } = parseCaip2(network);
    if (namespace !== expected.namespace) {
        throw unsupported(scope, `network "${network}" is not a ${expected.namespace}: network`);
    }
    if (reference !== expected.chainId.toString()) {
        throw unsupported(
            scope,
            `network "${network}" settles on chain ${reference}, but this wallet is ` +
                `on chain ${expected.chainId}`,
        );
    }
}

/**
 * Parse an amount- or asset-shaped field. x402 quotes these as decimal
 * integer strings; anything else (a float, hex, scientific notation) means
 * the offer was written against a different network's conventions.
 */
export function requirePositiveInteger(scope: string, value: string, field: string): bigint {
    if (!/^\d+$/.test(value)) {
        throw unsupported(scope, `${field} must be a decimal integer string, got "${value}"`, {
            cause: new InvalidArgumentError(`${field}: ${value}`, { argument: field }),
        });
    }
    const parsed = BigInt(value);
    if (parsed <= 0n) throw unsupported(scope, `${field} must be positive, got "${value}"`);
    return parsed;
}
