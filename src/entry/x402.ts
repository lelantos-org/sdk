// `@lelantos-org/sdk/x402`: x402 agent payments.
//
// x402 is the HTTP-402 standard for machine payments (x402 Foundation /
// Linux Foundation): a server answers 402 with payment requirements, the client
// attaches a signed payment, and the server serves the resource. This module
// lets a Lelantos wallet act as the payer.
//
//   import { connect } from "@lelantos-org/sdk";
//   import { x402 }    from "@lelantos-org/sdk/x402";
//
//   const wallet = await connect({ network: "base", rpcUrl, mnemonic, readOnly: true });
//   await wallet.sync();
//
//   const pay = x402(wallet, { budget: { total: "5" } });
//   const data = await pay("https://api.example.com/premium").then((r) => r.json());
//
// Payments are shielded by default, on the `shielded:<chainId>` network
// family described in `docs/x402-shielded-network.md`. Servers that accept only
// standard EVM `exact` can be paid by unshielding into a throwaway address
// (`allowUnshielded: true`, off by default).
//
// Both mechanisms structurally implement `@x402/core`'s `SchemeNetworkClient`,
// so an existing `x402Client` (e.g. for `@x402/mcp`, or combined with Solana)
// can register them directly without `x402()`:
//
//   client.register(shieldedNetwork(chainId), shieldedExact(wallet));
//   client.register(`eip155:${chainId}`,      unshieldedExact(wallet));

export { type Budget, BudgetLedger, type BudgetReservation } from "../x402/budget.js";
// The `exact` EVM payload, for a payer that already holds the token and so needs
// none of the unshielding `unshieldedExact` does: it signs from a plain viem
// account, not from a wallet.
export {
    requireEip712Domain,
    signTransferAuthorization,
    type TransferAuthorizationTerms,
    timeoutSeconds,
} from "../x402/eip3009.js";
export { deriveEphemeralKey } from "../x402/ephemeral.js";
export { type PayingFetch, type PaymentRecord, type X402Options, x402 } from "../x402/fetch.js";
export type { PayableSchemeClient, PaymentQuote } from "../x402/mechanism.js";
export { type Caip2, parseCaip2 } from "../x402/requirements.js";
export {
    DEFAULT_MIN_TIMEOUT_SECONDS,
    LELANTOS_POOL,
    SHIELDED_NAMESPACE,
    type ShieldedExactOptions,
    shieldedExact,
    shieldedNetwork,
} from "../x402/shielded.js";
export {
    HEADER_PAYMENT_REQUIRED,
    HEADER_PAYMENT_RESPONSE,
    HEADER_PAYMENT_SIGNATURE,
    type PaymentPayload,
    type PaymentPayloadContext,
    type PaymentPayloadResult,
    type PaymentRequired,
    type PaymentRequirements,
    type ResourceInfo,
    type SchemeNetworkClient,
    type SettleResponse,
    X402_VERSION,
} from "../x402/types.js";
export { EVM_NAMESPACE, type UnshieldedExactOptions, unshieldedExact } from "../x402/unshielded.js";
