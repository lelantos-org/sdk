// Fixtures for the x402 suites: assets, spend receipts and payment offers.
//
// Not shipped: `src/**/*test-utils*` is excluded from the build, coverage and the layer check.

import { vi } from "vitest";
import {
    assetId,
    circuitAmount,
    evmAddress,
    type Hex32,
    hex32,
    shieldedAddress,
    tokenAmount,
} from "../core/brand.js";
import { makeAssetInfo } from "../wallet/assets/index.js";
import type { SpendableMax, WithheldValue } from "../wallet/selection/index.js";
import { type ReadOnlyWalletInternals, registerInternals } from "../wallet/surface/internals.js";
import type { TransferResult, WithdrawResult } from "../wallet/types/results.js";
import type { PaymentRequirements } from "../x402/types.js";

export const X402_CHAIN_ID = 31337n;

/** scale 10^15: one circuit unit is 0.001 of an 18-decimal token. */
export const WETH = makeAssetInfo({
    id: assetId(1n),
    token: evmAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
    scale: 10n ** 15n,
    symbol: "WETH",
    decimals: 18,
});

/** 6-decimal token, scale 10^3: one circuit unit is 0.001 USDC. Registered as `id`. */
export function usdc(id = 2n) {
    return makeAssetInfo({
        id: assetId(id),
        token: evmAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
        scale: 10n ** 3n,
        symbol: "USDC",
        decimals: 6,
    });
}

/** More than any fixture offer asks for. */
const PLENTY = 10n ** 9n;

/** Nothing is out of reach. */
export const NOTHING_WITHHELD: WithheldValue = { reserved: 0n, dust: 0n, cooldown: 0n, slots: 0n };

/** What one asset holds: the reachable figure, or that plus why the rest is out of reach. */
export type Holding = bigint | { max: bigint; withheld: WithheldValue };

/**
 * A `wallet.spendableMax` spy over a table of {@link Holding} keyed by asset id.
 *
 * An asset with no entry holds {@link PLENTY}, so a suite that is not about
 * balances states nothing; `0n` is how a suite makes the shielded mechanism
 * reject an offer and the selector move on to the next.
 */
export function spendableMaxSpy(held: Record<string, Holding> = {}) {
    return vi.fn(async (ref: unknown): Promise<SpendableMax> => {
        const entry = held[BigInt(ref as bigint).toString()] ?? PLENTY;
        const { max, withheld } =
            typeof entry === "bigint" ? { max: entry, withheld: NOTHING_WITHHELD } : entry;
        return { max: circuitAmount(max), withheld };
    });
}

export const RECIPIENT_CM = hex32(`0x${"11".repeat(32)}`);
export const CHANGE_CM = hex32(`0x${"22".repeat(32)}`);

/** A result's shared fields, for spies that resolve a receipt. */
const base = (txHash: Hex32) => ({
    opId: "test-op",
    asset: WETH,
    txHash,
    fees: { protocol: null, relayer: null },
});

/**
 * A `wallet.transfer` spy resolving to a 1500-unit payment receipt.
 *
 * The payee is not at slot 0, since output slots are shuffled; a fixture with it first would also
 * pass a `commitments[0]` read.
 */
export function transferSpy(txHash: Hex32 = hex32(`0x${"de".repeat(32)}`)) {
    return vi.fn(
        async (): Promise<TransferResult> => ({
            ...base(txHash),
            kind: "transfer",
            commitments: [CHANGE_CM, RECIPIENT_CM],
            nonZeroCommitments: [CHANGE_CM, RECIPIENT_CM],
            ownCommitments: [CHANGE_CM],
            recipientCommitment: RECIPIENT_CM,
            recipient: shieldedAddress("lelantos1qqqq"),
            amount: { asset: WETH.id, amount: circuitAmount(1_500n), baseUnits: tokenAmount(0n) },
            spent: ["n1"],
            change: circuitAmount(8_500n),
        }),
    );
}

/** A `wallet.withdraw` spy; the suites assert on its calls, not on receipt amounts. */
export function withdrawSpy() {
    const zero = { asset: WETH.id, amount: circuitAmount(0n), baseUnits: tokenAmount(0n) };
    return vi.fn(
        async (): Promise<WithdrawResult> => ({
            ...base(hex32(`0x${"ff".repeat(32)}`)),
            kind: "withdraw",
            commitments: [RECIPIENT_CM, CHANGE_CM],
            nonZeroCommitments: [],
            ownCommitments: [],
            gross: zero,
            net: zero,
            recipient: evmAddress(`0x${"01".repeat(20)}`),
            native: false,
            onLadder: true,
            spent: [],
            change: circuitAmount(0n),
        }),
    );
}

/**
 * Register `nsk` as a stub wallet's internals, as `connect()` does for a real one: the unshielded
 * mechanism derives its payer from `walletInternals(wallet).keys.nsk`.
 */
export function withNsk<W extends object>(wallet: W, nsk: bigint): W {
    registerInternals(wallet, { keys: { nsk } } as unknown as ReadOnlyWalletInternals);
    return wallet;
}

/** A `shielded:<chainId>` offer for 1500 units of asset 1. */
export function shieldedRequirements(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
    return {
        scheme: "exact",
        network: `shielded:${X402_CHAIN_ID}`,
        amount: "1500",
        asset: "1",
        payTo: "lelantos1qqqq",
        maxTimeoutSeconds: 120,
        extra: { pool: "lelantos", paymentFlow: "upfront" },
        ...over,
    };
}
