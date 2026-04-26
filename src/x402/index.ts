// x402 agent payments. Also at the `./x402` subpath export.
//
// x402 is the HTTP-402 standard for machine payments (x402 Foundation /
// Linux Foundation): a server answers 402 with what it wants, the client
// attaches a signed payment, the server serves. This module makes a Lelantos
// wallet a valid payer.
//
//   import { connect } from "@lelantos-org/sdk";
//   import { x402 }    from "@lelantos-org/sdk/x402";
//
//   const wallet = await connect({ mnemonic, network: "anvil" });
//   await wallet.sync();
//
//   const pay = x402(wallet, { budget: { total: "5" } });
//   const data = await pay("https://api.example.com/premium").then((r) => r.json());
//
// Payments are shielded by default, on the `shielded:<chainId>` network
// family described in `docs/x402-shielded-network.md`. Servers that only
// speak standard EVM `exact` can be paid too, by unshielding into a
// throwaway address — that is `allowUnshielded: true`, off by default.
//
// The two mechanisms are structurally `@x402/core`'s `SchemeNetworkClient`,
// so an agent that already runs an `x402Client` (for `@x402/mcp`, or to
// combine with Solana) registers them directly and skips `x402()`:
//
//   client.register(shieldedNetwork(chainId), shieldedExact(wallet));
//   client.register(`eip155:${chainId}`,      unshieldedExact(wallet));

export { type Budget, BudgetLedger } from "./budget.js";
export { deriveEphemeralKey } from "./ephemeral.js";
export { type PayingFetch, type PaymentRecord, type X402Options, x402 } from "./fetch.js";
export type { PayableSchemeClient, PaymentQuote } from "./mechanism.js";
export { type Caip2, parseCaip2 } from "./requirements.js";
export {
    DEFAULT_MIN_TIMEOUT_SECONDS,
    LELANTOS_POOL,
    SHIELDED_NAMESPACE,
    type ShieldedExactOptions,
    shieldedExact,
    shieldedNetwork,
} from "./shielded.js";
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
} from "./types.js";
export { EVM_NAMESPACE, type UnshieldedExactOptions, unshieldedExact } from "./unshielded.js";
