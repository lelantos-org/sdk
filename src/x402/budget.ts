// Spend limits for an autonomous payer.
//
// An agent chooses its own purchases, so the risk to bound is an unbounded run
// of individually valid payments. Every check runs before any wallet method is
// called, so a refusal never leaves value in flight and an
// `X402PaymentError.reason` from these checks means no payment was made.
//
// Limits are in human decimal units, applied per asset: `{ total: "5" }` means
// five of each asset paid, not five across all assets (assets are not
// comparable without a price oracle).

import { branded, type CircuitAmount } from "../core/brand.js";
import { X402PaymentError } from "../errors/x402.js";
import { formatAmount, isYieldUnits, parseAmount } from "../wallet/assets/amount.js";
import { type AssetInfo, hasTokenMeta, requireTokenMeta } from "../wallet/assets/index.js";

/** Caps in human decimal units, applied per asset. */
export interface Budget {
    /** Cumulative ceiling for the lifetime of this payer. Required. */
    total: string;
    /** Ceiling for any single payment. Defaults to `total`. */
    perRequest?: string | undefined;
}

/**
 * A payment that has passed the limits and is being minted.
 *
 * Exactly one of `commit` / `release` must be called; both are idempotent, so
 * a `finally` that releases after a `commit` is safe.
 */
export interface BudgetReservation {
    /** The payment landed: move the hold into recorded spend. */
    commit(): void;
    /** The payment did not happen: return the held amount. */
    release(): void;
}

/**
 * Enforces {@link Budget} and the host allowlist, and tracks spend. One ledger
 * per `x402()` call; totals cover the payer's lifetime, not the process's.
 */
export class BudgetLedger {
    private readonly totals = new Map<bigint, bigint>();
    /** Reserved but not yet committed; see {@link BudgetLedger.reserve}. */
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
        // A cap never grows by rounding: exact on a plain asset, floored on a yield asset.
        const round = isYieldUnits(meta) ? "down" : "exact";
        const perRequest = parseAmount(this.budget.perRequest ?? this.budget.total, meta, {
            round,
        });
        if (amount > perRequest) {
            throw new X402PaymentError(
                "per-request-limit",
                `x402: payment of ${describe(amount, asset)} exceeds the per-request ` +
                    `limit of ${describe(perRequest, asset)}`,
                { resource },
            );
        }
        const total = parseAmount(this.budget.total, meta, { round });
        // Includes reservations: a payment being minted counts as spend before
        // it lands.
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
     * Minting a payment takes seconds (a Groth16 prove, then a submit), so
     * checking and recording separately would let concurrent payments all pass
     * the check before any is recorded, exceeding the budget.
     *
     * The reservation is synchronous and counts toward the limits until it is
     * committed or released, so concurrent callers see it.
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
 * Human amount when the asset has known decimals, raw circuit units otherwise.
 * The fallback is for messages only; limits without decimals are already
 * rejected by `requireTokenMeta`.
 */
function describe(amount: bigint, asset: AssetInfo): string {
    return hasTokenMeta(asset)
        ? formatAmount(branded<CircuitAmount>(amount), asset, { symbol: true })
        : `${amount} (circuit units of asset ${asset.id})`;
}
