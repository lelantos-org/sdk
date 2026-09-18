// The `eip155:<chainId>` payment mechanism: standard x402 `exact`.
//
// Opt-in, because it unshields. Many x402 servers accept only EIP-3009 on a
// public chain, so this pays from shielded funds by first unshielding into a
// throwaway address. The observable link is "a Lelantos withdrawal funded this
// address", not "the operator's account paid this API".
//
// The ephemeral address needs no gas: EIP-3009 is a signed authorization that
// the server's facilitator submits and pays for.
//
// Limits
// ------
// Usable only when the server offers a chain the MASP is deployed on and an
// EIP-3009-capable token (USDC and similar; most ERC-20s are not). No bridging:
// an offer on a different chain than the pool is refused.

import { privateKeyToAccount } from "viem/accounts";
import { createKeyedMutex, memoAsync } from "../core/async.js";
import {
    type AssetId,
    branded,
    type CircuitAmount,
    type EvmAddress,
    type TokenAmount,
} from "../core/brand.js";
import { getLogger } from "../log/logger.js";
import type { WalletApi } from "../wallet/api.js";
import type { AssetInfo } from "../wallet/assets/index.js";
import { walletInternals } from "../wallet/surface/internals.js";
import type { OpOptions, SpendPhase } from "../wallet/types/options.js";
import {
    requireEip712Domain,
    signTransferAuthorization,
    type TransferAuthorizationTerms,
    timeoutSeconds,
} from "./eip3009.js";
import { deriveEphemeralKey } from "./ephemeral.js";
import {
    assertFundable,
    ceilDiv,
    ensureFunded,
    resolveAsset,
    resolvePayerSlot,
    SCOPE,
} from "./funding.js";
import type { PayableSchemeClient, PaymentQuote } from "./mechanism.js";
import { requireEvmAddress, requireNetwork, requirePositiveInteger } from "./requirements.js";
import type { PaymentPayloadContext, PaymentPayloadResult, PaymentRequirements } from "./types.js";

const log = getLogger("lelantos:x402:unshielded");

/** CAIP-2 namespace for public EVM chains. */
export const EVM_NAMESPACE = "eip155";

export interface UnshieldedExactOptions {
    /**
     * MASP asset ids to consider when resolving the server's ERC-20 address.
     * Default: every registered asset over that token (each verified against
     * the pool). Pass ids to restrict which assets may fund a payment.
     */
    assetIds?: readonly AssetId[] | undefined;
    /**
     * Pin the ephemeral payer slot. Defaults to a slot derived from the
     * resource host, giving each server a distinct payer address (see
     * `hostPayerIndex`). Set to reuse one address across hosts.
     */
    index?: number | undefined;
    /**
     * When a top-up is needed, withdraw this many times the payment so one
     * proving run covers several calls. Default 10.
     */
    topUpMultiple?: bigint | undefined;
    /** Forwarded to `wallet.withdraw`. */
    onPhase?: OpOptions<SpendPhase>["onPhase"];
    /** Poll interval while waiting for the withdrawal to land. Default 2000ms. */
    pollMs?: number | undefined;
    /** Give up waiting after this many polls. Default 30. */
    maxPolls?: number | undefined;
    /**
     * Fires when a top-up is about to unshield into the payer address.
     *
     * The budget caps *payments*, not the withdrawals that fund them: a top-up
     * moves value to an address the user controls, so counting it would
     * double-count every payment made from it. Because `topUpMultiple`
     * withdraws more than one payment costs, and a poll timeout leaves no other
     * record, this hook makes top-ups observable.
     *
     * Must not throw.
     */
    onTopUp?:
        | ((info: { payer: EvmAddress; asset: AssetId; amount: CircuitAmount }) => void)
        | undefined;
}

/** Everything an offer yields once it is known to be payable: what it authorizes, and the asset. */
interface Terms extends Omit<TransferAuthorizationTerms, "validForSeconds"> {
    asset: AssetInfo;
}

/**
 * Mechanism for `scheme: "exact"` on `network: "eip155:<chainId>"`, paying
 * from a deterministic throwaway address funded by unshielding.
 *
 * ```ts
 * client.register(`eip155:${chainId}`, unshieldedExact(wallet));
 * ```
 */
export function unshieldedExact(
    wallet: WalletApi,
    opts: UnshieldedExactOptions = {},
): PayableSchemeClient {
    const candidates = opts.assetIds;
    const topUpMultiple = opts.topUpMultiple ?? 10n;

    // Per slot, not global: slots are distinct ephemeral addresses, so
    // concurrent payments to different hosts top up in parallel.
    const funding = createKeyedMutex<number>();
    // Memoised with eviction on rejection: `x402()` builds this mechanism once
    // for a long-lived `fetch`, so a transient RPC failure must not be cached
    // for the process lifetime.
    const chainId = memoAsync(() => wallet.chain.chainId());
    const read = async (req: PaymentRequirements): Promise<Terms> => {
        const id = await chainId.get();
        requireNetwork(SCOPE, req.network, { namespace: EVM_NAMESPACE, chainId: id });
        const token = requireEvmAddress(SCOPE, req.asset, "asset");
        return {
            domain: requireEip712Domain(req),
            value: branded<TokenAmount>(requirePositiveInteger(SCOPE, req.amount, "amount")),
            asset: await resolveAsset(wallet, token, candidates),
            token,
            chainId: id,
            payTo: requireEvmAddress(SCOPE, req.payTo, "payTo"),
        };
    };

    /** The throwaway account this resource is paid from. Deterministic; see `ephemeral.ts`. */
    const payerFor = (host: string | undefined) => {
        const slot = resolvePayerSlot(opts.index, host);
        if (slot.provenance === "shared") {
            // `x402()` always supplies a host; reached only from clients that
            // do not.
            log.warn("no resource host — paying from the shared payer slot", {
                index: slot.index,
            });
        }
        // The spending key stays off the wallet object; the internals registry holds it.
        const { nsk } = walletInternals(wallet).keys;
        return { slot, account: privateKeyToAccount(deriveEphemeralKey(nsk, slot.index)) };
    };

    return {
        scheme: "exact",

        async quote(req: PaymentRequirements, ctx?: PaymentPayloadContext): Promise<PaymentQuote> {
            const { value, asset } = await read(req);
            // Asked here, where a refusal is still routable: funding happens in
            // `createPaymentPayload`, and a refusal from there aborts the
            // request instead of falling through to the next offer.
            const { account } = payerFor(ctx?.host);
            await assertFundable(wallet, branded<EvmAddress>(account.address), asset, value);
            // Base units → circuit units, rounded up, so a budget never
            // under-counts what a payment draws from the pool.
            return { amount: branded<CircuitAmount>(ceilDiv(value, asset.scale)), asset };
        },

        async createPaymentPayload(
            x402Version: number,
            req: PaymentRequirements,
            ctx?: PaymentPayloadContext,
        ): Promise<PaymentPayloadResult> {
            const terms = await read(req);
            const { value, asset } = terms;
            const { slot, account } = payerFor(ctx?.host);

            // Serialised per payer slot. `ensureFunded` awaits between reading
            // the balance and deciding to withdraw; without the lock,
            // concurrent payments to one host could both unshield for a single
            // shortfall, or both sign against a balance that covers only one,
            // making the second settlement revert on chain.
            await funding.run(slot.index, () =>
                ensureFunded(wallet, branded<EvmAddress>(account.address), asset, value, {
                    topUpMultiple,
                    onPhase: opts.onPhase,
                    onTopUp: opts.onTopUp,
                    pollMs: opts.pollMs ?? 2000,
                    maxPolls: opts.maxPolls ?? 30,
                }),
            );

            // The validated `payTo` and token, never the raw offer strings.
            const payload = await signTransferAuthorization(account, {
                ...terms,
                validForSeconds: timeoutSeconds(req),
            });
            log.debug("signed eip3009 authorization", {
                payer: account.address,
                value: value.toString(),
            });
            return { x402Version, payload };
        },
    };
}
