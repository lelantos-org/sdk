// Shared vocabulary for reading a server's `PaymentRequirements`.
//
// Each check answers "can this wallet pay this offer?". Every failure is
// `unsupported-requirements`, which the selector treats as "skip to the next
// `accepts[]` entry"; a refusal with any other reason aborts the request.

import {
    type AssetId,
    assetId,
    branded,
    type CircuitAmount,
    type EvmAddress,
    evmAddress,
    type ShieldedAddress,
    shieldedAddress,
} from "../core/brand.js";
import { InvalidArgumentError } from "../errors/config.js";
import { X402PaymentError } from "../errors/x402.js";

/**
 * "This wallet cannot pay this offer": recoverable; the caller tries the next
 * offer. `scope` names the mechanism for the message prefix.
 *
 * Returns the error rather than throwing, so call sites read as
 * `throw unsupported(...)`.
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
 * ≥3 chars and contains a colon; further checks happen here.
 */
export function parseCaip2(network: string): Caip2 {
    const i = network.indexOf(":");
    if (i < 0) return { namespace: "", reference: network };
    return { namespace: network.slice(0, i), reference: network.slice(i + 1) };
}

/**
 * Require an offer to be on `namespace:<this wallet's chain>`.
 *
 * The message distinguishes the two halves: a wrong namespace means the offer
 * targets a different mechanism; a wrong reference means the right mechanism
 * on another chain (no bridging).
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
 * integer strings; anything else (float, hex, scientific notation) indicates
 * a different network's conventions.
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

/** Positive integer, branded as an amount in this network's own denomination. */
export function requireAmount(scope: string, value: string, field: string): CircuitAmount {
    return branded<CircuitAmount>(requirePositiveInteger(scope, value, field));
}

/**
 * A server-quoted MASP asset id.
 *
 * Range failures are `unsupported-requirements`, so a bad offer falls through
 * to the next `accepts[]` entry instead of aborting the request.
 */
export function requireAssetId(scope: string, value: string, field: string): AssetId {
    const raw = requirePositiveInteger(scope, value, field);
    try {
        return assetId(raw);
    } catch (cause) {
        throw unsupported(scope, `${field} is not a valid asset id: ${value}`, { cause });
    }
}

/** A server-supplied EVM address. */
export function requireEvmAddress(scope: string, value: string, field: string): EvmAddress {
    try {
        return evmAddress(value);
    } catch (cause) {
        throw unsupported(scope, `${field} is not an EVM address: ${value}`, { cause });
    }
}

/** A server-supplied shielded address. */
export function requireShieldedAddress(
    scope: string,
    value: string,
    field: string,
): ShieldedAddress {
    try {
        return shieldedAddress(value);
    } catch (cause) {
        throw unsupported(scope, `${field} is not a shielded address: ${value}`, { cause });
    }
}
