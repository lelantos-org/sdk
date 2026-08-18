// The `eip155:<chainId>` payment mechanism — standard x402 `exact`.
//
// Opt-in, because it unshields. Most deployed x402 servers speak only
// EIP-3009 on a public chain, so this pays them from shielded funds by
// unshielding into a throwaway address first: the observable link is "some
// Lelantos withdrawal funded this address", not "the operator's account paid
// this API".
//
// The ephemeral address never needs gas: EIP-3009 is a signed authorization
// that the server's facilitator submits and pays for.
//
// Limits
// ------
// Usable only when the server offers both a chain the MASP is deployed on and
// an EIP-3009-capable token (USDC and similar; most ERC-20s are not). No
// bridging: if the server wants USDC on Base and the pool is on mainnet, this
// mechanism refuses.

import { privateKeyToAccount } from "viem/accounts";
import { createKeyedMutex, memoAsync, sleep } from "../core/async.js";
import {
    type AssetId,
    branded,
    type CircuitAmount,
    type EvmAddress,
    type TokenAmount,
} from "../core/brand.js";
import { safeCall } from "../core/callbacks.js";
import { bytesToHex } from "../core/hex.js";
import { randomBytes } from "../core/random.js";
import { getLogger } from "../log/logger.js";
import type { WalletApi } from "../wallet/api.js";
import type { AssetInfo } from "../wallet/assets.js";
import { DEFAULT_ASSET } from "../wallet/constants.js";
import type { OnPhase, SpendPhase } from "../wallet/options.js";
import { deriveEphemeralKey, hostPayerIndex } from "./ephemeral.js";
import type { PayableSchemeClient, PaymentQuote } from "./mechanism.js";
import {
    requireEvmAddress,
    requireNetwork,
    requirePositiveInteger,
    unsupported,
} from "./requirements.js";
import type { PaymentPayloadContext, PaymentPayloadResult, PaymentRequirements } from "./types.js";

const log = getLogger("lelantos:x402:unshielded");

/** Message prefix, and the label this mechanism is known by. */
const SCOPE = "unshielded";

/** CAIP-2 namespace for public EVM chains. */
export const EVM_NAMESPACE = "eip155";

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

export interface UnshieldedExactOptions {
    /**
     * MASP asset ids to consider when resolving the server's ERC-20 address.
     * Defaults to the single default asset. The registry is not enumerable,
     * so the token→id direction has to be a lookup over candidates.
     */
    assetIds?: readonly AssetId[] | undefined;
    /**
     * Pin the ephemeral payer slot. Defaults to a slot derived from the
     * resource host, giving each server a distinct payer address — see
     * `hostPayerIndex`. Set to reuse one address across hosts.
     */
    index?: number | undefined;
    /**
     * When a top-up is needed, withdraw this many times the payment so one
     * proving run covers several calls. Default 10.
     */
    topUpMultiple?: bigint | undefined;
    /** Forwarded to `wallet.withdraw`. */
    onPhase?: OnPhase<SpendPhase> | undefined;
    /** Poll interval while waiting for the withdrawal to land. Default 2000ms. */
    pollMs?: number | undefined;
    /** Give up waiting after this many polls. Default 30. */
    maxPolls?: number | undefined;
    /**
     * Fires when a top-up is about to unshield into the payer address.
     *
     * The budget caps *payments*, not the withdrawals that fund them, and it
     * cannot do otherwise: a top-up moves value to an address the user still
     * controls, so counting it as spend would double-count every payment made
     * from it. But `topUpMultiple` means far more leaves the pool than any one
     * payment costs, and if the poll below times out it has left with nothing
     * recorded anywhere. This is the hook that makes that observable.
     *
     * Must not throw.
     */
    onTopUp?:
        | ((info: { payer: EvmAddress; asset: AssetId; amount: CircuitAmount }) => void)
        | undefined;
}

/** Everything an offer yields once it is known to be payable. */
interface Terms {
    /** EIP-712 domain of the token, from `extra`. */
    domain: { name: string; version: string };
    /** ERC-20 base units owed. */
    value: TokenAmount;
    asset: AssetInfo;
    chainId: bigint;
    /** Server's ERC-20 recipient. */
    payTo: EvmAddress;
}

/**
 * Ephemeral payer slot and how it was chosen.
 *
 * `"shared"` means no host was available, so every such payment lands on the
 * same slot and therefore the same publicly-funded EVM address. The
 * provenance is carried so that case can be reported rather than pass
 * silently.
 */
interface PayerSlot {
    index: number;
    provenance: "pinned" | "host" | "shared";
}

/** Slot used when nothing identifies the resource. See `PayerSlot`. */
const SHARED_PAYER_INDEX = 0;

/**
 * Ceiling on an EIP-3009 authorization window: 1 hour.
 *
 * The authorization is a bearer instrument until it expires, so a server that
 * asks for a year gets an hour.
 */
const MAX_AUTHORIZATION_SECONDS = 3600;

function resolvePayerSlot(pinned: number | undefined, host: string | undefined): PayerSlot {
    if (pinned !== undefined) return { index: pinned, provenance: "pinned" };
    if (host) return { index: hostPayerIndex(host), provenance: "host" };
    return { index: SHARED_PAYER_INDEX, provenance: "shared" };
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
    const candidates = opts.assetIds ?? [DEFAULT_ASSET];
    const topUpMultiple = opts.topUpMultiple ?? 10n;

    // Per slot, not global: slots are distinct ephemeral addresses, so
    // concurrent payments to different hosts still top up in parallel.
    const funding = createKeyedMutex<number>();
    // Memoised with eviction on rejection: `x402()` builds this mechanism once
    // and returns a long-lived `fetch`, so a single RPC blip on the first read
    // would otherwise be replayed to every later payment for the process
    // lifetime.
    const chainId = memoAsync(() => wallet.chain.chainId());
    const read = async (req: PaymentRequirements): Promise<Terms> => {
        const id = await chainId.get();
        requireNetwork(SCOPE, req.network, { namespace: EVM_NAMESPACE, chainId: id });
        return {
            domain: requireEip712Domain(req),
            value: branded<TokenAmount>(requirePositiveInteger(SCOPE, req.amount, "amount")),
            asset: await resolveAsset(
                wallet,
                requireEvmAddress(SCOPE, req.asset, "asset"),
                candidates,
            ),
            chainId: id,
            payTo: requireEvmAddress(SCOPE, req.payTo, "payTo"),
        };
    };

    return {
        scheme: "exact",

        async quote(req: PaymentRequirements): Promise<PaymentQuote> {
            const { value, asset } = await read(req);
            // Base units → circuit units, rounded up, so a budget never
            // under-counts what a payment draws from the pool.
            return { amount: branded<CircuitAmount>(ceilDiv(value, asset.scale)), asset };
        },

        async createPaymentPayload(
            x402Version: number,
            req: PaymentRequirements,
            ctx?: PaymentPayloadContext,
        ): Promise<PaymentPayloadResult> {
            const { domain, value, asset, chainId: id } = await read(req);
            const slot = resolvePayerSlot(opts.index, ctx?.host);
            if (slot.provenance === "shared") {
                // `x402()` always supplies a host; this path is reached only
                // when the mechanism is driven by a client that does not.
                log.warn("no resource host — paying from the shared payer slot", {
                    index: slot.index,
                });
            }
            const account = privateKeyToAccount(deriveEphemeralKey(wallet.keys.nsk, slot.index));

            // Serialised per payer slot. `ensureFunded` reads the balance and
            // then decides whether to withdraw, with an await in between — so
            // two concurrent payments to the same host both saw the pre-top-up
            // balance and both unshielded: two proofs for one shortfall. The
            // symmetric case is worse — both see a sufficient balance, both
            // sign a full-value authorization, and the second settlement
            // reverts on chain.
            await funding.run(slot.index, () =>
                ensureFunded(wallet, branded<EvmAddress>(account.address), asset, value, {
                    topUpMultiple,
                    onPhase: opts.onPhase,
                    onTopUp: opts.onTopUp,
                    pollMs: opts.pollMs ?? 2000,
                    maxPolls: opts.maxPolls ?? 30,
                }),
            );

            const authorization = {
                from: account.address,
                to: req.payTo as `0x${string}`,
                value,
                validAfter: 0n,
                validBefore: BigInt(Math.floor(Date.now() / 1000) + timeoutSeconds(req)),
                nonce: bytesToHex(randomBytes(32)) as `0x${string}`,
            };

            const signature = await account.signTypedData({
                domain: {
                    ...domain,
                    chainId: Number(id),
                    verifyingContract: req.asset as `0x${string}`,
                },
                types: TRANSFER_WITH_AUTHORIZATION,
                primaryType: "TransferWithAuthorization",
                message: authorization,
            });

            log.debug("signed eip3009 authorization", {
                payer: account.address,
                value: value.toString(),
            });

            return {
                x402Version,
                payload: {
                    signature,
                    // Every numeric field goes on the wire as a string; a
                    // bigint would not survive `JSON.stringify`.
                    authorization: {
                        from: authorization.from,
                        to: authorization.to,
                        value: authorization.value.toString(),
                        validAfter: authorization.validAfter.toString(),
                        validBefore: authorization.validBefore.toString(),
                        nonce: authorization.nonce,
                    },
                },
            };
        },
    };
}

/**
 * Unshield into `payer` when its balance will not cover `needed`. Withdraws
 * a multiple so the next several payments need no proof at all.
 */
async function ensureFunded(
    wallet: WalletApi,
    payer: EvmAddress,
    asset: AssetInfo,
    needed: TokenAmount,
    opts: {
        topUpMultiple: bigint;
        onPhase?: OnPhase<SpendPhase> | undefined;
        pollMs: number;
        maxPolls: number;
        onTopUp?: UnshieldedExactOptions["onTopUp"];
    },
): Promise<void> {
    const { tokenBalanceOf } = wallet.chain;
    if (!tokenBalanceOf) {
        throw unsupported(
            SCOPE,
            "chain adapter has no `tokenBalanceOf`, so the payer balance cannot be " +
                "checked — pass a fuller adapter or use the shielded mechanism",
        );
    }
    const balanceOf = () => tokenBalanceOf.call(wallet.chain, asset.token, payer);

    const held = await balanceOf();
    if (held >= needed) return;

    // Withdraw is fee-inclusive (`publicOut = amount + fee`), so a top-up of
    // exactly `needed` arrives short. Asking for a multiple absorbs the fee
    // and amortises the proof across later payments.
    const shortfall = needed - held;
    const target = branded<CircuitAmount>(ceilDiv(shortfall * opts.topUpMultiple, asset.scale));

    log.info("topping up ephemeral payer", {
        payer,
        asset: asset.id.toString(),
        circuitUnits: target.toString(),
    });
    // Reported before the withdraw, so a caller still hears about value that
    // left the pool even if the poll below times out.
    safeCall("onTopUp", opts.onTopUp, { payer, asset: asset.id, amount: target });
    await wallet.withdraw({ to: payer, amount: target, asset: asset.id, onPhase: opts.onPhase });

    for (let i = 0; i < opts.maxPolls; i++) {
        await sleep(opts.pollMs);
        if ((await balanceOf()) >= needed) return;
    }
    throw unsupported(
        SCOPE,
        `withdrawal to ${payer} did not land within ` +
            `${(opts.pollMs * opts.maxPolls) / 1000}s. The funds are not lost — ` +
            `retry once the relayer has flushed.`,
    );
}

/** ERC-20 address → MASP asset, by probing the candidate registry ids. */
async function resolveAsset(
    wallet: WalletApi,
    token: EvmAddress,
    candidates: readonly AssetId[],
): Promise<AssetInfo> {
    const want = token.toLowerCase();
    for (const id of candidates) {
        const info = await wallet.asset(id);
        if (info.token.toLowerCase() === want) return info;
    }
    throw unsupported(
        SCOPE,
        `token ${token} is not among the MASP assets checked (${candidates.join(", ")}). ` +
            "Pass `assetIds` naming the registry id that backs it.",
    );
}

/**
 * `exact` on EVM requires the token's EIP-712 domain in `extra`; without it
 * the signature would be computed against the wrong domain separator and
 * silently fail verification.
 */
function requireEip712Domain(req: PaymentRequirements): { name: string; version: string } {
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

function ceilDiv(a: bigint, b: bigint): bigint {
    return (a + b - 1n) / b;
}

/**
 * `maxTimeoutSeconds` from the offer, validated and clamped.
 *
 * Server-supplied, and the only requirement field that skipped the `require*`
 * guards. A non-integer produced `BigInt(NaN)` — a `RangeError`, not an
 * `X402PaymentError`, so `isRoutable` said no and the whole request aborted
 * rather than falling through to the next `accepts[]` entry. A huge value
 * minted an authorization valid for years that the facilitator could hold and
 * replay against a later top-up. The shielded mechanism validates its own
 * window; this is the matching guard.
 */
function timeoutSeconds(req: PaymentRequirements): number {
    const seconds = req.maxTimeoutSeconds;
    if (typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0) {
        throw unsupported(SCOPE, `maxTimeoutSeconds ${seconds} is not a positive integer`);
    }
    return Math.min(seconds, MAX_AUTHORIZATION_SECONDS);
}
