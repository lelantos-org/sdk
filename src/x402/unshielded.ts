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
import { sleep } from "../core/async.js";
import { bytesToHex } from "../core/hex.js";
import { randomBytes } from "../core/random.js";
import { getLogger } from "../log/logger.js";
import type { WalletApi } from "../wallet/api.js";
import type { AssetInfo } from "../wallet/assets.js";
import type { OnPhase, SpendPhase } from "../wallet/options.js";
import { deriveEphemeralKey } from "./ephemeral.js";
import type { PayableSchemeClient, PaymentQuote } from "./mechanism.js";
import { requireNetwork, requirePositiveInteger, unsupported } from "./requirements.js";
import type { PaymentPayloadResult, PaymentRequirements } from "./types.js";

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
     * Default `[1n]`. The registry is not enumerable, so the token→id
     * direction has to be a lookup over candidates.
     */
    assetIds?: readonly bigint[];
    /** Ephemeral payer slot. Default 0. See `./ephemeral.ts`. */
    index?: number;
    /**
     * When a top-up is needed, withdraw this many times the payment so one
     * proving run covers several calls. Default 10.
     */
    topUpMultiple?: bigint;
    /** Forwarded to `wallet.withdraw`. */
    onPhase?: OnPhase<SpendPhase>;
    /** Poll interval while waiting for the withdrawal to land. Default 2000ms. */
    pollMs?: number;
    /** Give up waiting after this many polls. Default 30. */
    maxPolls?: number;
}

/** Everything an offer yields once it is known to be payable. */
interface Terms {
    /** EIP-712 domain of the token, from `extra`. */
    domain: { name: string; version: string };
    /** ERC-20 base units owed. */
    value: bigint;
    asset: AssetInfo;
    chainId: bigint;
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
    const index = opts.index ?? 0;
    const candidates = opts.assetIds ?? [1n];
    const topUpMultiple = opts.topUpMultiple ?? 10n;

    let chainId: Promise<bigint> | undefined;
    const read = async (req: PaymentRequirements): Promise<Terms> => {
        chainId ??= wallet.chain.chainId();
        const id = await chainId;
        requireNetwork(SCOPE, req.network, { namespace: EVM_NAMESPACE, chainId: id });
        return {
            domain: requireEip712Domain(req),
            value: requirePositiveInteger(SCOPE, req.amount, "amount"),
            asset: await resolveAsset(wallet, req.asset, candidates),
            chainId: id,
        };
    };

    return {
        scheme: "exact",

        async quote(req: PaymentRequirements): Promise<PaymentQuote> {
            const { value, asset } = await read(req);
            // Base units → circuit units, rounded up, so a budget never
            // under-counts what a payment draws from the pool.
            return { amount: ceilDiv(value, asset.scale), asset };
        },

        async createPaymentPayload(
            x402Version: number,
            req: PaymentRequirements,
        ): Promise<PaymentPayloadResult> {
            const { domain, value, asset, chainId: id } = await read(req);
            const account = privateKeyToAccount(deriveEphemeralKey(wallet.keys.nsk, index));

            await ensureFunded(wallet, account.address, asset, value, {
                topUpMultiple,
                onPhase: opts.onPhase,
                pollMs: opts.pollMs ?? 2000,
                maxPolls: opts.maxPolls ?? 30,
            });

            const authorization = {
                from: account.address,
                to: req.payTo as `0x${string}`,
                value,
                validAfter: 0n,
                validBefore: BigInt(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds),
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
    payer: string,
    asset: AssetInfo,
    needed: bigint,
    opts: {
        topUpMultiple: bigint;
        onPhase?: OnPhase<SpendPhase>;
        pollMs: number;
        maxPolls: number;
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
    const target = ceilDiv(shortfall * opts.topUpMultiple, asset.scale);

    log.info("topping up ephemeral payer", {
        payer,
        asset: asset.id.toString(),
        circuitUnits: target.toString(),
    });
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
    token: string,
    candidates: readonly bigint[],
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
