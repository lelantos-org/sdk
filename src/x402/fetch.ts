// `x402()` — wrap a `fetch` so 402 responses are paid and retried.
//
// This is the whole integration surface. Because the result is an ordinary
// `fetch`, every agent framework already accepts it:
//
//   createOpenAI({ fetch: pay });                            // Vercel AI SDK
//   new StreamableHTTPClientTransport(url, { fetch: pay });   // MCP
//
// The 402 loop is implemented here rather than delegated to `@x402/fetch` so
// the one-liner needs no extra install. Callers who already run an
// `x402Client` — to combine these mechanisms with Solana, or to use
// `@x402/mcp` — should register `shieldedExact` / `unshieldedExact` on it
// directly instead; both are structurally `SchemeNetworkClient`.
//
// Exactly-once
// ------------
// A payment is attached to at most one retry per call. There is no loop: a
// paid request that comes back 402 is `payment-rejected`, not a reason to pay
// twice. This wrapper also sits outside `createHttpClient`'s retry machinery
// for the same reason — 5xx retries must never re-run a payment.

import { X402PaymentError } from "../core/errors.js";
import { getLogger } from "../log/logger.js";
import type { WalletApi } from "../wallet/api.js";
import { type Budget, BudgetLedger } from "./budget.js";
import { readPaymentRequired, readSettlement, requestUrl, withPaymentHeader } from "./codec.js";
import type { PayableSchemeClient, PaymentQuote } from "./mechanism.js";
import { parseCaip2 } from "./requirements.js";
import { SHIELDED_NAMESPACE, type ShieldedExactOptions, shieldedExact } from "./shielded.js";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "./types.js";
import { X402_VERSION } from "./types.js";
import { EVM_NAMESPACE, type UnshieldedExactOptions, unshieldedExact } from "./unshielded.js";

const log = getLogger("lelantos:x402");

/** What was paid, for audit trails. */
export interface PaymentRecord {
    /** Resource that demanded payment. */
    url: string;
    /** The `accepts[]` entry that was satisfied. */
    requirements: PaymentRequirements;
    /** True when the payment unshielded (the `eip155:*` mechanism). */
    unshielded: boolean;
    /** Server's settlement receipt, when it sent one. */
    settlement?: SettleResponse;
}

export interface X402Options {
    /**
     * Required, so an autonomous payer always has a ceiling. Human decimal
     * units, applied per asset.
     */
    budget: Budget;
    /**
     * Also pay servers that only speak standard EVM `exact`. Unshields into a
     * throwaway address, so it is off by default.
     */
    allowUnshielded?: boolean;
    /** Only pay these hostnames. Unset means any host. */
    allowHosts?: string[];
    /** Fired after each successful payment. Errors from it are swallowed. */
    onPayment?: (record: PaymentRecord) => void;
    /** Passed through to the shielded mechanism. */
    shielded?: ShieldedExactOptions;
    /** Passed through to the unshielded mechanism. */
    unshielded?: UnshieldedExactOptions;
    /** Defaults to bound `globalThis.fetch`. */
    fetchImpl?: typeof fetch;
}

/** A `fetch` that settles 402s. */
export interface PayingFetch {
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
    /** Circuit units spent so far, keyed by MASP asset id. */
    spent(): Map<bigint, bigint>;
}

/**
 * Wrap `fetch` so that a 402 is paid from the shielded pool and the request
 * retried once.
 *
 * ```ts
 * const wallet = await connect({ mnemonic, network: "anvil" });
 * await wallet.sync();
 *
 * const pay = x402(wallet, { budget: { total: "5" } });
 * const data = await pay("https://api.example.com/premium").then((r) => r.json());
 * ```
 *
 * Returns synchronously — nothing is contacted until the first call.
 */
export function x402(wallet: WalletApi, opts: X402Options): PayingFetch {
    if (!opts?.budget?.total) {
        throw new X402PaymentError(
            "budget-exceeded",
            "x402: `budget.total` is required — an agent with an unbounded wallet " +
                'is a footgun. Pass e.g. `{ budget: { total: "5" } }`.',
        );
    }

    const ledger = new BudgetLedger(opts.budget, opts.allowHosts);
    const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

    const mechanisms = new Map<string, PayableSchemeClient>([
        [SHIELDED_NAMESPACE, shieldedExact(wallet, opts.shielded)],
    ]);
    if (opts.allowUnshielded) {
        mechanisms.set(EVM_NAMESPACE, unshieldedExact(wallet, opts.unshielded));
    }

    const paying = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const res = await doFetch(input, init);
        if (res.status !== 402) return res;

        const url = requestUrl(input);
        ledger.assertHostAllowed(url);

        const required = await readPaymentRequired(res, url);
        const chosen = await select(required.accepts, mechanisms, ledger, url);
        const { requirements } = chosen;

        log.info("paying for resource", {
            url,
            scheme: requirements.scheme,
            network: requirements.network,
        });

        const result = await chosen.mechanism.createPaymentPayload(
            required.x402Version || X402_VERSION,
            requirements,
        );
        const payload: PaymentPayload = {
            x402Version: result.x402Version,
            accepted: requirements,
            payload: result.payload,
            ...(required.resource ? { resource: required.resource } : {}),
            ...(result.extensions ? { extensions: result.extensions } : {}),
        };

        // The payment is made. Record it before the retry so a network failure
        // on the retry cannot under-count what was spent.
        ledger.record(chosen.quote.amount, chosen.quote.asset.id);

        const paid = await doFetch(input, withPaymentHeader(init, payload));
        if (paid.status === 402) {
            throw new X402PaymentError(
                "payment-rejected",
                `x402: ${url} returned 402 again after payment ` +
                    `(${requirements.scheme} on ${requirements.network}). ` +
                    "The payment was made; do not retry blindly.",
                { resource: url },
            );
        }

        report(opts.onPayment, {
            url,
            requirements,
            unshielded: chosen.namespace === EVM_NAMESPACE,
            settlement: readSettlement(paid),
        });
        return paid;
    };

    return Object.assign(paying, { spent: () => ledger.spent() });
}

interface Choice {
    mechanism: PayableSchemeClient;
    requirements: PaymentRequirements;
    namespace: string;
    quote: PaymentQuote;
}

/**
 * Pick an offer to pay: shielded networks first, original order within a
 * tier, first affordable one wins.
 *
 * The two failure kinds are treated differently. An offer this wallet cannot
 * satisfy — wrong chain, unknown token, a window too short to prove in — is a
 * routing problem, so the next offer gets a turn. A budget breach stops
 * everything: falling through to a cheaper offer would hide that a caller's
 * ceiling was hit.
 */
async function select(
    accepts: PaymentRequirements[],
    mechanisms: Map<string, PayableSchemeClient>,
    ledger: BudgetLedger,
    url: string,
): Promise<Choice> {
    const rejections: string[] = [];

    for (const requirements of preferShielded(accepts)) {
        const { namespace } = parseCaip2(requirements.network);
        const mechanism = mechanisms.get(namespace);
        if (!mechanism || mechanism.scheme !== requirements.scheme) {
            rejections.push(`${describe(requirements)}: no mechanism`);
            continue;
        }
        try {
            // The mechanism prices its own network — see `PaymentQuote`.
            const quote = await mechanism.quote(requirements);
            ledger.assertWithinLimits(quote.amount, quote.asset, url);
            return { mechanism, requirements, namespace, quote };
        } catch (err) {
            if (!isRoutable(err)) throw err;
            rejections.push(`${describe(requirements)}: ${err.message}`);
        }
    }

    throw new X402PaymentError(
        "no-acceptable-requirements",
        `x402: nothing offered by ${url} is payable by this wallet. Tried: ` +
            (rejections.join("; ") || "(server offered no options)"),
        { resource: url },
    );
}

/** Stable sort: shielded offers first, otherwise the server's own order. */
function preferShielded(accepts: readonly PaymentRequirements[]): PaymentRequirements[] {
    const shielded: PaymentRequirements[] = [];
    const rest: PaymentRequirements[] = [];
    for (const req of accepts) {
        const tier = parseCaip2(req.network).namespace === SHIELDED_NAMESPACE ? shielded : rest;
        tier.push(req);
    }
    return [...shielded, ...rest];
}

/** Only "this offer does not suit us" lets the search continue. */
function isRoutable(err: unknown): err is X402PaymentError {
    return err instanceof X402PaymentError && err.reason === "unsupported-requirements";
}

function describe(req: PaymentRequirements): string {
    return `${req.scheme} on ${req.network}`;
}

function report(hook: ((r: PaymentRecord) => void) | undefined, record: PaymentRecord): void {
    if (!hook) return;
    try {
        hook(record);
    } catch (err) {
        log.warn("onPayment callback threw", { err: String(err) });
    }
}
