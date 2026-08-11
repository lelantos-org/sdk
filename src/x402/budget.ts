// Spend limits for an autonomous payer.
//
// An agent chooses its own purchases, so the risk to bound is an unbounded run
// of individually valid payments. Every check runs before any wallet method is
// called, so a refusal never leaves value in flight and
// `X402PaymentError.reason` always means nothing happened.
//
// Limits are written in human decimal units and interpreted per asset:
// `{ total: "5" }` means five of each distinct asset paid, not five across all
// of them. Assets are not comparable without a price oracle.

import { X402PaymentError } from "../core/errors.js";
import { type AssetInfo, formatAmount, parseAmount } from "../wallet/assets.js";

/** Caps in human decimal units, applied per asset. */
export interface Budget {
    /** Cumulative ceiling for the lifetime of this payer. Required. */
    total: string;
    /** Ceiling for any single payment. Defaults to `total`. */
    perRequest?: string;
}

/**
 * Enforces {@link Budget} and the host allowlist, and remembers what has
 * been spent. One ledger per `x402()` call — the totals are the payer's
 * lifetime, not the process's.
 */
export class BudgetLedger {
    private readonly totals = new Map<bigint, bigint>();
    private readonly hosts?: ReadonlySet<string>;

    constructor(
        private readonly budget: Budget,
        allowHosts?: readonly string[],
    ) {
        this.hosts = allowHosts ? new Set(allowHosts.map((h) => h.toLowerCase())) : undefined;
    }

    /** @throws {X402PaymentError} `host-not-allowed` */
    assertHostAllowed(url: string): void {
        if (!this.hosts) return;
        let host: string;
        try {
            host = new URL(url).hostname.toLowerCase();
        } catch {
            throw new X402PaymentError("host-not-allowed", `x402: "${url}" is not a valid URL`, {
                resource: url,
            });
        }
        if (!this.hosts.has(host)) {
            throw new X402PaymentError(
                "host-not-allowed",
                `x402: refusing to pay ${host} — not in allowHosts ` +
                    `(${[...this.hosts].join(", ")})`,
                { resource: url },
            );
        }
    }

    /**
     * @param amount Circuit units for this asset.
     * @throws {X402PaymentError} `per-request-limit` or `budget-exceeded`
     */
    assertWithinLimits(amount: bigint, asset: AssetInfo, resource?: string): void {
        const perRequest = parseAmount(this.budget.perRequest ?? this.budget.total, asset);
        if (amount > perRequest) {
            throw new X402PaymentError(
                "per-request-limit",
                `x402: payment of ${describe(amount, asset)} exceeds the per-request ` +
                    `limit of ${describe(perRequest, asset)}`,
                { resource },
            );
        }
        const total = parseAmount(this.budget.total, asset);
        const already = this.totals.get(asset.id) ?? 0n;
        if (already + amount > total) {
            throw new X402PaymentError(
                "budget-exceeded",
                `x402: payment of ${describe(amount, asset)} would take total spend to ` +
                    `${describe(already + amount, asset)}, over the budget of ` +
                    `${describe(total, asset)}`,
                { resource },
            );
        }
    }

    /** Call only once a payment has been made. */
    record(amount: bigint, asset: bigint): void {
        this.totals.set(asset, (this.totals.get(asset) ?? 0n) + amount);
    }

    /** Circuit units spent so far, keyed by asset id. */
    spent(): Map<bigint, bigint> {
        return new Map(this.totals);
    }
}

/**
 * Human amount when the asset has known decimals, raw circuit units when it
 * does not — `parseAmount` already threw if a *limit* needed decimals, so
 * this only guards the message itself.
 */
function describe(amount: bigint, asset: AssetInfo): string {
    try {
        return formatAmount(amount, asset, { symbol: true });
    } catch {
        return `${amount} (circuit units of asset ${asset.id})`;
    }
}
