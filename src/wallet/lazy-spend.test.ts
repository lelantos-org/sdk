// The spend path is loaded on demand.
//
// `wallet.ts` reaches `deposit`/`transfer`/`withdraw`/`swap` through
// `await import(...)`, so a caller that only reads never downloads the prover
// or viem. A wrong specifier there fails at the first spend, not at build time,
// and no other test calls those four methods.
//
// `bundle-budget.mjs` guards the laziness itself.

import { describe, expect, it } from "vitest";

describe("lazily loaded spend modules", () => {
    it.each([
        ["./deposit.js", "executeDeposit"],
        ["./transfer.js", "executeTransfer"],
        ["./withdraw.js", "executeWithdraw"],
        ["./swap.js", "executeSwap"],
    ])("%s exports %s", async (specifier, name) => {
        const mod = (await import(specifier)) as Record<string, unknown>;
        expect(typeof mod[name]).toBe("function");
    });
});
