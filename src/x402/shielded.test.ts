// The wire contract for `shielded:<chainId>`. These assertions are the
// executable form of `docs/x402-shielded-network.md`; changing one changes the
// spec and affects every server implementing it.

import { describe, expect, it, vi } from "vitest";
import { hex32 } from "../core/brand.js";
import {
    type Holding,
    NOTHING_WITHHELD,
    RECIPIENT_CM,
    SHIELDED_PAY_TO,
    shieldedRequirements,
    spendableMaxSpy,
    transferSpy,
    WETH,
    X402_CHAIN_ID,
} from "../test-utils/x402.js";
import type { WalletApi } from "../wallet/api.js";
import { LELANTOS_POOL, SHIELDED_NAMESPACE, shieldedExact, shieldedNetwork } from "./shielded.js";
import type { PaymentRequirements } from "./types.js";

const CHAIN_ID = X402_CHAIN_ID;

function stubWallet(held: Record<string, Holding> = {}) {
    const transfer = transferSpy(hex32(`0x${"fe".repeat(32)}`));
    const chainId = vi.fn(async () => CHAIN_ID);
    const asset = vi.fn(async () => WETH);
    const spendableMax = spendableMaxSpy(held);
    return {
        wallet: { chain: { chainId }, asset, spendableMax, transfer } as unknown as WalletApi,
        transfer,
        chainId,
        spendableMax,
    };
}

describe("shieldedNetwork", () => {
    it("is CAIP-2 shaped, which is all @x402/core validates", () => {
        const network = shieldedNetwork(11155111n);
        expect(network).toBe("shielded:11155111");
        expect(network.length).toBeGreaterThanOrEqual(3);
        expect(network).toContain(":");
    });
});

describe("shieldedExact", () => {
    it("claims the accepted `exact` scheme rather than inventing one", () => {
        expect(shieldedExact(stubWallet().wallet).scheme).toBe("exact");
    });

    it("transfers to payTo and returns the receipt payload", async () => {
        const { wallet, transfer } = stubWallet();
        const result = await shieldedExact(wallet).createPaymentPayload(2, shieldedRequirements());

        expect(transfer).toHaveBeenCalledWith(
            expect.objectContaining({ recipient: SHIELDED_PAY_TO, amount: 1500n, asset: 1n }),
        );
        expect(result).toEqual({
            x402Version: 2,
            payload: {
                pool: LELANTOS_POOL,
                txHash: hex32(`0x${"fe".repeat(32)}`),
                // The receipt's `recipientCommitment`; the sender's change
                // commitment would make the payment unverifiable.
                commitment: RECIPIENT_CM,
                asset: "1",
                amount: "1500",
            },
        });
    });

    it("echoes amount and asset as the server wrote them", async () => {
        const { wallet } = stubWallet();
        const result = await shieldedExact(wallet).createPaymentPayload(
            2,
            shieldedRequirements({ amount: "0000001500" }),
        );
        expect(result.payload.amount).toBe("0000001500");
    });

    it("memoises the chain id across quote and payment", async () => {
        const { wallet, chainId } = stubWallet();
        const mechanism = shieldedExact(wallet);
        await mechanism.quote(shieldedRequirements());
        await mechanism.createPaymentPayload(2, shieldedRequirements());
        expect(chainId).toHaveBeenCalledTimes(1);
    });

    it("treats a missing `extra.pool` as compatible", async () => {
        const { wallet } = stubWallet();
        await expect(
            shieldedExact(wallet).quote(shieldedRequirements({ extra: {} })),
        ).resolves.toBeTruthy();
    });
});

describe("shieldedExact.quote", () => {
    it("prices in circuit units, which this network already quotes in", async () => {
        const { wallet, transfer } = stubWallet();
        const quote = await shieldedExact(wallet).quote(shieldedRequirements());
        expect(quote).toEqual({ amount: 1500n, asset: WETH });
        // Pricing must not move value; the selector calls it on offers it may
        // discard.
        expect(transfer).not.toHaveBeenCalled();
    });

    const rejects = async (over: Partial<PaymentRequirements>, pattern: RegExp) => {
        const { wallet, transfer } = stubWallet();
        await expect(shieldedExact(wallet).quote(shieldedRequirements(over))).rejects.toThrow(
            pattern,
        );
        expect(transfer).not.toHaveBeenCalled();
    };

    it("refuses a non-shielded network", () =>
        rejects({ network: `eip155:${CHAIN_ID}` }, new RegExp(`not a ${SHIELDED_NAMESPACE}:`)));

    it("refuses another chain", () =>
        rejects({ network: "shielded:8453" }, /settles on chain 8453/));

    it("refuses another pool", () => rejects({ extra: { pool: "somepool" } }, /is not "lelantos"/));

    it("refuses a window shorter than a proof takes", () =>
        rejects({ maxTimeoutSeconds: 5 }, /below the 20s needed to generate a proof/));

    it("refuses a non-integer amount", () =>
        rejects({ amount: "1.5" }, /amount must be a decimal integer/));

    it("refuses a zero amount", () => rejects({ amount: "0" }, /amount must be positive/));

    it("refuses a non-integer asset id", () =>
        rejects({ asset: "0xC02aaA39" }, /asset must be a decimal integer/));

    it("refuses a payTo that is not a `lelantos1…` address", async () => {
        const evm = "0x0000000000000000000000000000000000000001";
        // A viewing key shares the charset and differs only in its prefix.
        for (const payTo of [evm, "lelantosivk1qqqq", SHIELDED_PAY_TO.toUpperCase(), ""]) {
            await rejects({ payTo }, /payTo is not a shielded address/);
        }
    });

    it("refuses an offer in an asset this wallet cannot cover", async () => {
        // `unsupported-requirements`, so `select` moves to the next `accepts[]`
        // entry instead of aborting.
        const { wallet, transfer } = stubWallet({ 1: 1_499n });
        await expect(shieldedExact(wallet).quote(shieldedRequirements())).rejects.toThrow(
            /1499 spendable unit\(s\) of asset 1 \(WETH\) is short of the 1500/,
        );
        expect(transfer).not.toHaveBeenCalled();
    });

    it("counts value stranded beyond the input arity, which consolidation recovers", async () => {
        // `slots` is withheld by note count, not by time, and `autoConsolidate`
        // merges those notes before paying, so an offer reachable in two
        // spends is still payable.
        const thin = { 1: { max: 1_000n, withheld: { ...NOTHING_WITHHELD, slots: 1_000n } } };

        await expect(
            shieldedExact(stubWallet(thin).wallet).quote(shieldedRequirements()),
        ).resolves.toBeTruthy();
        await expect(
            shieldedExact(stubWallet(thin).wallet, { autoConsolidate: false }).quote(
                shieldedRequirements(),
            ),
        ).rejects.toThrow(/1000 spendable unit\(s\)/);
    });

    it("does not count value withheld by cooldown, dust or a pending spend", async () => {
        const { wallet } = stubWallet({
            1: {
                max: 500n,
                withheld: { reserved: 3_000n, dust: 500n, cooldown: 5_000n, slots: 0n },
            },
        });
        await expect(shieldedExact(wallet).quote(shieldedRequirements())).rejects.toThrow(
            /500 spendable unit\(s\)/,
        );
    });

    it("honours a caller-supplied minimum window", async () => {
        const { wallet } = stubWallet();
        await expect(
            shieldedExact(wallet, { minTimeoutSeconds: 3 }).quote(
                shieldedRequirements({ maxTimeoutSeconds: 5 }),
            ),
        ).resolves.toBeTruthy();
    });
});
