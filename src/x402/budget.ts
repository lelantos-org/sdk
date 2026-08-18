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

import { branded, type CircuitAmount } from "../core/brand.js";
import { X402PaymentError } from "../core/errors.js";
import {
    type AssetInfo,
    formatAmount,
    hasTokenMeta,
    parseAmount,
    requireTokenMeta,
} from "../wallet/assets.js";

/** Caps in human decimal units, applied per asset. */
export interface Budget {
    /** Cumulative ceiling for the lifetime of this payer. Required. */
    total: string;
    /** Ceiling for any single payment. Defaults to `total`. */
    perRequest?: string | undefined;
}

/**
 * Enforces {@link Budget} and the host allowlist, and remembers what has
 * been spent. One ledger per `x402()` call — the totals are the payer's
 * lifetime, not the process's.
 */
/**
 * A payment that has passed the limits and is being minted.
 *
 * Exactly one of `commit` / `release` must be called; both are idempotent, so
 * a `finally` that releases after a `commit` is safe.
 */
export interface BudgetReservation {
    /** The payment landed: move the hold into recorded spend. */
    commit(): void;
    /** The payment did not happen: give the headroom back. */
    release(): void;
}

export class BudgetLedger {
    private readonly totals = new Map<bigint, bigint>();
    /** Reserved but not yet committed — see {@link BudgetLedger.reserve}. */
    private readonly held = new Map<bigint, bigint>();
    private readonly hosts?: ReadonlySet<string> | undefined;

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
    assertWithinLimits(amount: CircuitAmount, asset: AssetInfo, resource?: string): void {
        const meta = requireTokenMeta(asset);
        const perRequest = parseAmount(this.budget.perRequest ?? this.budget.total, meta);
        if (amount > perRequest) {
            throw new X402PaymentError(
                "per-request-limit",
                `x402: payment of ${describe(amount, asset)} exceeds the per-request ` +
                    `limit of ${describe(perRequest, asset)}`,
                { resource },
            );
        }
        const total = parseAmount(this.budget.total, meta);
        // Reservations included: a payment being minted right now is spend the
        // wallet has committed to, even though it has not landed yet.
        const already = (this.totals.get(asset.id) ?? 0n) + (this.held.get(asset.id) ?? 0n);
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

    /**
     * Check the limits and hold `amount` against them in one step.
     *
     * Checking and recording separately is not enough: minting a payment takes
     * seconds (a Groth16 prove, then a submit), and nothing held the ledger
     * across that await — so N concurrent payments all passed the check before
     * any of them recorded, and the budget was enforced against a total that
     * ignored every payment still in flight. With `{ total: "5" }` and 1-unit
     * payments, twenty concurrent calls all went through.
     *
     * The reservation is synchronous and counts toward the limits until it is
     * committed or released, so a concurrent caller sees it.
     *
     * @throws {X402PaymentError} `per-request-limit` or `budget-exceeded`
     */
    reserve(amount: CircuitAmount, asset: AssetInfo, resource?: string): BudgetReservation {
        this.assertWithinLimits(amount, asset, resource);
        this.held.set(asset.id, (this.held.get(asset.id) ?? 0n) + amount);

        let settled = false;
        const settle = (commit: boolean) => {
            if (settled) return;
            settled = true;
            this.held.set(asset.id, (this.held.get(asset.id) ?? 0n) - amount);
            if (commit) this.record(amount, asset.id);
        };
        return { commit: () => settle(true), release: () => settle(false) };
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
 * does not. Only the message needs this fallback — a limit that needed
 * decimals has already been rejected by `requireTokenMeta`.
 */
function describe(amount: bigint, asset: AssetInfo): string {
    return hasTokenMeta(asset)
        ? formatAmount(branded<CircuitAmount>(amount), asset, { symbol: true })
        : `${amount} (circuit units of asset ${asset.id})`;
}
