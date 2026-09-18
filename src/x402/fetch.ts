// `x402()`: wrap a `fetch` so 402 responses are paid and retried.
//
// This is the entire integration surface. The result is an ordinary `fetch`, so
// agent frameworks accept it directly:
//
//   createOpenAI({ fetch: pay });                            // Vercel AI SDK
//   new StreamableHTTPClientTransport(url, { fetch: pay });   // MCP
//
// The 402 handling is implemented here rather than delegated to `@x402/fetch`,
// so no extra install is needed. Callers with an existing `x402Client` (e.g. to
// combine with Solana or use `@x402/mcp`) should register `shieldedExact` /
// `unshieldedExact` on it directly; both are structurally `SchemeNetworkClient`.
//
// Exactly-once
// ------------
// A payment is attached to at most one retry per call. A paid request that
// returns 402 is `payment-rejected` and is not paid again. For the same reason
// this wrapper sits outside `createHttpClient`'s retry logic: 5xx retries must
// never re-run a payment.

import { X402PaymentError } from "../errors/x402.js";
import { getLogger } from "../log/logger.js";
import type { WalletApi } from "../wallet/api.js";
import { type Budget, BudgetLedger, type BudgetReservation } from "./budget.js";
import { hostOf, readPaymentRequired, readSettlement, withPaymentRequest } from "./codec.js";
import type { PayableSchemeClient, PaymentQuote } from "./mechanism.js";
import { parseCaip2 } from "./requirements.js";
import { SHIELDED_NAMESPACE, type ShieldedExactOptions, shieldedExact } from "./shielded.js";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "./types.js";
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
    settlement?: SettleResponse | undefined;
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
    allowUnshielded?: boolean | undefined;
    /** Only pay these hostnames. Unset means any host. */
    allowHosts?: string[] | undefined;
    /** Fired after each successful payment. Errors from it are swallowed. */
    onPayment?: ((record: PaymentRecord) => void) | undefined;
    /** Passed through to the shielded mechanism. */
    shielded?: ShieldedExactOptions | undefined;
    /** Passed through to the unshielded mechanism. */
    unshielded?: UnshieldedExactOptions | undefined;
    /**
     * Transport for the wrapped requests, named as `connect`'s `http` option. `fetch` defaults to
     * `globalThis.fetch`, looked up at call time.
     */
    http?: { fetch?: typeof fetch | undefined } | undefined;
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
 * const wallet = await connect({ network: "base", rpcUrl, mnemonic, readOnly: true });
 * await wallet.sync();
 *
 * const pay = x402(wallet, { budget: { total: "5" } });
 * const data = await pay("https://api.example.com/premium").then((r) => r.json());
 * ```
 *
 * Returns synchronously; no network request is made until the first call.
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
    const doFetch = opts.http?.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

    const mechanisms = new Map<string, PayableSchemeClient>([
        [SHIELDED_NAMESPACE, shieldedExact(wallet, opts.shielded)],
    ]);
    if (opts.allowUnshielded) {
        mechanisms.set(EVM_NAMESPACE, unshieldedExact(wallet, opts.unshielded));
    }

    const paying = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        // Normalised up front and cloned for the first fetch, which consumes the
        // body; the original is kept intact for the paid retry.
        const req = new Request(input instanceof URL ? input.toString() : input, init);
        const res = await doFetch(req.clone());
        if (res.status !== 402) return res;

        const url = req.url;
        ledger.assertHostAllowed(url);

        const required = readPaymentRequired(res, url);
        const chosen = await select(required.accepts, mechanisms, ledger, url);
        const { requirements } = chosen;

        // Host only: a full URL would log the paid request path at info level.
        log.info("paying for resource", {
            host: hostOf(url),
            scheme: requirements.scheme,
            network: requirements.network,
        });

        let result: Awaited<ReturnType<PayableSchemeClient["createPaymentPayload"]>>;
        try {
            result = await chosen.mechanism.createPaymentPayload(
                required.x402Version,
                requirements,
                { host: hostOf(url) },
            );
        } catch (err) {
            // Nothing was spent; release the reservation.
            chosen.reservation.release();
            throw err;
        }

        const payload: PaymentPayload = {
            x402Version: result.x402Version,
            accepted: requirements,
            payload: result.payload,
            ...(required.resource ? { resource: required.resource } : {}),
            ...(result.extensions ? { extensions: result.extensions } : {}),
        };

        // The payment is made. Commit before the retry so a network failure on
        // the retry does not under-count spend.
        chosen.reservation.commit();

        const paid = await doFetch(withPaymentRequest(req, payload));
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
    /** Held against the budget from selection until the payment settles. */
    reservation: BudgetReservation;
}

/**
 * Pick an offer to pay: shielded networks first, original order within a
 * tier, first affordable one wins.
 *
 * An offer this wallet cannot satisfy (wrong chain, unknown token, too little of
 * the asset it is priced in, a window too short to prove in) moves on to the
 * next offer — which is what lets a server price one resource in several assets
 * and be paid in whichever of them the payer holds. A budget breach aborts:
 * falling through to a cheaper offer would hide that the caller's ceiling was
 * reached.
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
            // The mechanism prices its own network and judges whether this
            // wallet can pay it; see `PaymentQuote`. The host goes with the
            // offer, so a per-host payer is judged as it will be paid.
            const quote = await mechanism.quote(requirements, { host: hostOf(url) });
            // Reserved, not only checked: minting the payload takes seconds and
            // concurrent payments must account for this one.
            const reservation = ledger.reserve(quote.amount, quote.asset, url);
            return { mechanism, requirements, namespace, quote, reservation };
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

/** Only `unsupported-requirements` lets the search continue. */
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
