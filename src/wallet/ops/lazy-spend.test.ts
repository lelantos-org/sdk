// The spend path is loaded on demand.
//
// `wallet.ts` loads `deposit`/`transfer`/`withdraw`/`swap` via `await import(...)`, so a
// read-only caller never downloads the prover or viem. A wrong specifier fails at the first spend
// rather than at build time, so this test checks each module resolves.
//
// `bundle-budget.mjs` verifies the modules stay lazily loaded.

import { describe, expect, it } from "vitest";

describe("lazily loaded spend modules", () => {
    it.each([
        ["./deposit.js", "executeDeposit"],
        ["./transfer.js", "executeTransfer"],
        ["./withdraw.js", "executeWithdraw"],
        ["./swap.js", "executeSwap"],
        ["./quote-swap.js", "quoteSwap"],
        ["./fee-quote.js", "quoteFee"],
    ])("%s exports %s", async (specifier, name) => {
        const mod = (await import(specifier)) as Record<string, unknown>;
        expect(typeof mod[name]).toBe("function");
    });
});
