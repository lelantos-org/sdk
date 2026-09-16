// EIP-3009 `TransferWithAuthorization`: the signed authorization an `exact` EVM payment carries.
//
// The payer needs no gas: the server's facilitator submits the authorization and pays for it.

import type { PrivateKeyAccount } from "viem/accounts";
import type { EvmAddress, TokenAmount } from "../core/brand.js";
import { randomHex } from "../core/random.js";
import { unixNow } from "../core/time.js";
import { SCOPE } from "./funding.js";
import { unsupported } from "./requirements.js";
import type { PaymentPayloadResult, PaymentRequirements } from "./types.js";

/** EIP-3009 `TransferWithAuthorization`, the default `exact` EVM mechanism. */
const TRANSFER_WITH_AUTHORIZATION = {
    TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
    ],
} as const;

/**
 * Ceiling on an EIP-3009 authorization window: 1 hour.
 *
 * The authorization is a bearer instrument until it expires, so longer
 * server-requested windows are clamped.
 */
const MAX_AUTHORIZATION_SECONDS = 3600;

/** What an authorization binds, all validated from the offer. */
export interface TransferAuthorizationTerms {
    /** The token's EIP-712 domain, from `extra`. */
    domain: { name: string; version: string };
    chainId: bigint;
    /** The token contract: the domain's verifying contract. */
    token: EvmAddress;
    payTo: EvmAddress;
    /** ERC-20 base units. */
    value: TokenAmount;
    /** How long the authorization stays valid; see {@link timeoutSeconds}. */
    validForSeconds: number;
}

/**
 * Sign a `TransferWithAuthorization` from `account` and shape it as the `exact` EVM payload.
 *
 * The nonce is random, not sequential: EIP-3009 nonces are unordered, and a predictable one would
 * let a facilitator front-run a later authorization.
 */
export async function signTransferAuthorization(
    account: PrivateKeyAccount,
    terms: TransferAuthorizationTerms,
): Promise<PaymentPayloadResult["payload"]> {
    const authorization = {
        from: account.address,
        to: terms.payTo,
        value: terms.value,
        validAfter: 0n,
        validBefore: BigInt(unixNow() + terms.validForSeconds),
        nonce: `0x${randomHex(32)}` as const,
    };
    const signature = await account.signTypedData({
        domain: { ...terms.domain, chainId: Number(terms.chainId), verifyingContract: terms.token },
        types: TRANSFER_WITH_AUTHORIZATION,
        primaryType: "TransferWithAuthorization",
        message: authorization,
    });
    return {
        signature,
        // Numeric fields are strings on the wire; `JSON.stringify` does not accept bigint.
        authorization: {
            from: authorization.from,
            to: authorization.to,
            value: authorization.value.toString(),
            validAfter: authorization.validAfter.toString(),
            validBefore: authorization.validBefore.toString(),
            nonce: authorization.nonce,
        },
    };
}

/**
 * `exact` on EVM requires the token's EIP-712 domain in `extra`; without it the
 * signature would use the wrong domain separator and fail verification.
 */
export function requireEip712Domain(req: PaymentRequirements): { name: string; version: string } {
    const method = req.extra?.assetTransferMethod;
    if (method !== undefined && method !== "eip3009") {
        throw unsupported(SCOPE, `assetTransferMethod "${String(method)}" is not supported`);
    }
    const { name, version } = req.extra ?? {};
    if (typeof name !== "string" || typeof version !== "string") {
        throw unsupported(
            SCOPE,
            "requirements are missing `extra.name` / `extra.version`, which the " +
                "EIP-3009 domain separator needs",
        );
    }
    return { name, version };
}

/**
 * `maxTimeoutSeconds` from the offer, validated and clamped.
 *
 * Server-supplied. An invalid value throws `X402PaymentError` (not a
 * `RangeError` from `BigInt`) so `isRoutable` falls through to the next
 * `accepts[]` entry. The clamp prevents a long-lived authorization that a
 * facilitator could hold and replay against a later top-up. The shielded
 * mechanism applies an equivalent check.
 */
export function timeoutSeconds(req: PaymentRequirements): number {
    const seconds = req.maxTimeoutSeconds;
    if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0) {
        throw unsupported(SCOPE, `maxTimeoutSeconds ${seconds} is not a positive integer`);
    }
    return Math.min(seconds, MAX_AUTHORIZATION_SECONDS);
}
