// The `shielded:<chainId>` payment mechanism.
//
// x402's `exact` scheme is chain-agnostic — "transfers a specific amount of
// funds from a client to a resource server" — and is extended by per-network
// implementation documents (Solana, Stellar, TON, Sui each have one). A
// shielded transfer is exactly `exact` semantics, so this is a new *network*
// family under an accepted scheme rather than a new scheme.
//
// The wire format is pool-agnostic: `extra.pool` is the only
// implementation-specific field, so any shielded pool can serve and accept
// the same requirements. See `docs/x402-shielded-network.md`.
//
// Payment flow
// ------------
// `extra.paymentFlow: "upfront"` — the transfer is submitted before the
// resource is served, and the payload is the receipt. x402's default
// `authorization` flow (hand over an unsubmitted proof, let the server settle
// it) is more trust-minimal but needs a facilitator that can relay a Lelantos
// bundle; until one exists, upfront is the only available model. It exposes
// the payer to a server that takes payment and does not answer, which is why
// `budget` is required rather than optional.

import type { AssetId, CircuitAmount, ShieldedAddress } from "../core/brand.js";
import { getLogger } from "../log/logger.js";
import type { WalletApi } from "../wallet/api.js";
import type { OnPhase, SpendPhase } from "../wallet/options.js";
import type { PayableSchemeClient, PaymentQuote } from "./mechanism.js";
import {
    requireAmount,
    requireAssetId,
    requireNetwork,
    requireShieldedAddress,
    unsupported,
} from "./requirements.js";
import type { PaymentPayloadResult, PaymentRequirements } from "./types.js";

const log = getLogger("lelantos:x402:shielded");

/** Message prefix, and the label this mechanism is known by. */
const SCOPE = "shielded";

/** CAIP-2 namespace for shielded-pool payments. */
export const SHIELDED_NAMESPACE = "shielded";

/** Value of `extra.pool` this SDK produces and accepts. */
export const LELANTOS_POOL = "lelantos";

/**
 * Lower bound on `maxTimeoutSeconds`. A shielded payment includes a Groth16
 * proof, which takes seconds — accepting a 5-second window would mean paying
 * into a requirement the server has already stopped honouring.
 */
export const DEFAULT_MIN_TIMEOUT_SECONDS = 20;

/** The network id this wallet pays on. */
export function shieldedNetwork(chainId: bigint): string {
    return `${SHIELDED_NAMESPACE}:${chainId}`;
}

export interface ShieldedExactOptions {
    /** Forwarded to `wallet.transfer` — `"proving"` is the multi-second phase. */
    onPhase?: OnPhase<SpendPhase> | undefined;
    /** Reject requirements whose window is shorter than this. Default 20. */
    minTimeoutSeconds?: number | undefined;
    /** Self-spend to make a payable note when no 2-note cover exists. Default true. */
    autoConsolidate?: boolean | undefined;
}

/** Everything an offer yields once it is known to be payable. */
interface Terms {
    asset: AssetId;
    amount: CircuitAmount;
    payTo: ShieldedAddress;
}

/**
 * Mechanism for `scheme: "exact"` on `network: "shielded:<chainId>"`.
 *
 * Register it on an `@x402/core` client:
 *
 * ```ts
 * const chainId = await wallet.chain.chainId();
 * client.register(shieldedNetwork(chainId), shieldedExact(wallet));
 * ```
 *
 * or let {@link x402} do it for you.
 */
export function shieldedExact(
    wallet: WalletApi,
    opts: ShieldedExactOptions = {},
): PayableSchemeClient {
    const minTimeoutSeconds = opts.minTimeoutSeconds ?? DEFAULT_MIN_TIMEOUT_SECONDS;

    // Memoised: an offer is read once while selecting and again while paying,
    // and a wallet's chain cannot change underneath it.
    let chainId: Promise<bigint> | undefined;
    const read = async (req: PaymentRequirements): Promise<Terms> => {
        chainId ??= wallet.chain.chainId();
        requireNetwork(SCOPE, req.network, {
            namespace: SHIELDED_NAMESPACE,
            chainId: await chainId,
        });
        requirePool(req);
        requireProvableWindow(req, minTimeoutSeconds);
        return {
            asset: requireAssetId(SCOPE, req.asset, "asset"),
            amount: requireAmount(SCOPE, req.amount, "amount"),
            payTo: requireShieldedAddress(SCOPE, req.payTo, "payTo"),
        };
    };

    return {
        scheme: "exact",

        async quote(req: PaymentRequirements): Promise<PaymentQuote> {
            const terms = await read(req);
            // Already circuit units — this network quotes in the wallet's own
            // denomination, which is the point of having its own namespace.
            return { amount: terms.amount, asset: await wallet.asset(terms.asset) };
        },

        async createPaymentPayload(
            x402Version: number,
            req: PaymentRequirements,
        ): Promise<PaymentPayloadResult> {
            const { asset, amount, payTo } = await read(req);

            log.debug("paying shielded", {
                network: req.network,
                asset: asset.toString(),
                amount: amount.toString(),
            });

            const result = await wallet.transfer({
                to: payTo,
                amount,
                asset,
                onPhase: opts.onPhase,
                autoConsolidate: opts.autoConsolidate ?? true,
            });

            return {
                x402Version,
                payload: {
                    pool: LELANTOS_POOL,
                    txHash: result.txHash,
                    // Output 0 is the recipient note; output 1 is the payer's
                    // change, which the server could not verify.
                    commitment: result.commitments[0],
                    asset: req.asset,
                    amount: req.amount,
                },
            };
        },
    };
}

/** Absent means "any pool" — only a mismatch is a refusal. */
function requirePool(req: PaymentRequirements): void {
    const pool = req.extra?.pool;
    if (pool !== undefined && pool !== LELANTOS_POOL) {
        throw unsupported(SCOPE, `pool "${String(pool)}" is not "${LELANTOS_POOL}"`);
    }
}

function requireProvableWindow(req: PaymentRequirements, minTimeoutSeconds: number): void {
    if (req.maxTimeoutSeconds < minTimeoutSeconds) {
        throw unsupported(
            SCOPE,
            `maxTimeoutSeconds=${req.maxTimeoutSeconds} is below the ${minTimeoutSeconds}s ` +
                `needed to generate a proof — the payment would land after the window closed`,
        );
    }
}
