// The `shielded:<chainId>` payment mechanism.
//
// x402's `exact` scheme is chain-agnostic ("transfers a specific amount of
// funds from a client to a resource server") and is extended by per-network
// implementation documents (Solana, Stellar, TON, Sui). A shielded transfer has
// `exact` semantics, so this is a new *network* family under an existing
// scheme rather than a new scheme.
//
// The wire format is pool-agnostic: `extra.pool` is the only
// implementation-specific field, so any shielded pool can serve and accept
// the same requirements. See `docs/x402-shielded-network.md`.
//
// Payment flow
// ------------
// `extra.paymentFlow: "upfront"`: the transfer is submitted before the resource
// is served, and the payload is the receipt. x402's default `authorization`
// flow (hand over an unsubmitted proof for the server to settle) requires a
// facilitator that can relay a Lelantos bundle, so upfront is the only
// supported model. It exposes the payer to a server that takes payment without
// responding, which is why `budget` is required.

import { memoAsync } from "../core/async.js";
import type { AssetId, CircuitAmount, ShieldedAddress } from "../core/brand.js";
import { getLogger } from "../log/logger.js";
import type { WalletApi } from "../wallet/api.js";
import type { OpOptions, SpendPhase } from "../wallet/types/options.js";
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
 * proof that takes seconds; a shorter window could expire before the payment
 * lands.
 */
export const DEFAULT_MIN_TIMEOUT_SECONDS = 20;

/** The network id this wallet pays on. */
export function shieldedNetwork(chainId: bigint): string {
    return `${SHIELDED_NAMESPACE}:${chainId}`;
}

export interface ShieldedExactOptions {
    /** Forwarded to `wallet.transfer`; `"proving"` is the multi-second phase. */
    onPhase?: OpOptions<SpendPhase>["onPhase"];
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
 * or delegate to {@link x402}.
 */
export function shieldedExact(
    wallet: WalletApi,
    opts: ShieldedExactOptions = {},
): PayableSchemeClient {
    const minTimeoutSeconds = opts.minTimeoutSeconds ?? DEFAULT_MIN_TIMEOUT_SECONDS;
    const autoConsolidate = opts.autoConsolidate ?? true;

    // Memoised: an offer is read during selection and again during payment,
    // and a wallet's chain does not change. Evicted on rejection because
    // `x402()` builds this mechanism once for a long-lived `fetch`, so a
    // transient RPC failure must not be cached for the process lifetime.
    const chainId = memoAsync(() => wallet.chain.chainId());
    const read = async (req: PaymentRequirements): Promise<Terms> => {
        requireNetwork(SCOPE, req.network, {
            namespace: SHIELDED_NAMESPACE,
            chainId: await chainId.get(),
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
            // An offer priced in an asset this wallet cannot cover is
            // `unsupported`, not a failure: the selector walks `accepts[]` in
            // order and only a mechanism can say whether its own network's offer
            // is payable. Without this, a server offering the same tool in
            // several assets would always have its first shielded entry chosen,
            // and the request would die inside `transfer` rather than falling
            // through to the entry this wallet could actually have paid.
            //
            // Asked as `kind: "transfer"` so the gate and the spend apply one
            // rule: a bare balance ignores the relayer fee the payment must also
            // cover, and would pass an offer `transfer` then refuses seconds
            // later, with no fall-through left. `slots` is added back when
            // consolidation may run, since that is the one withheld cause a
            // spend can still recover.
            const { max, withheld } = await wallet.spendableMax(terms.asset, { kind: "transfer" });
            const reachable = max + (autoConsolidate ? withheld.slots : 0n);
            const asset = await wallet.asset(terms.asset);
            if (reachable < terms.amount) {
                const symbol = asset.symbol ? ` (${asset.symbol})` : "";
                throw unsupported(
                    SCOPE,
                    `${reachable} spendable unit(s) of asset ${terms.asset}${symbol} is short ` +
                        `of the ${terms.amount} this offer asks for`,
                );
            }
            // Already circuit units: this network quotes in the wallet's
            // denomination.
            return { amount: terms.amount, asset };
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
                recipient: payTo,
                amount,
                asset,
                onPhase: opts.onPhase,
                autoConsolidate,
            });

            // Taken from the receipt, not a fixed index: output slots are
            // shuffled, and the other slots (payer change, relayer fee) are not
            // verifiable by the server.
            return {
                x402Version,
                payload: {
                    pool: LELANTOS_POOL,
                    txHash: result.txHash,
                    commitment: result.recipientCommitment,
                    asset: req.asset,
                    amount: req.amount,
                },
            };
        },
    };
}

/** Absent means "any pool"; only a mismatch is refused. */
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
