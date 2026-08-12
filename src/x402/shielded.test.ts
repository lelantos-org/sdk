// The wire contract for `shielded:<chainId>`. These assertions are the
// executable half of `docs/x402-shielded-network.md` — changing one means
// changing the spec, and every server implementing it.

import { describe, expect, it, vi } from "vitest";
import { assetId, circuitAmount, evmAddress, hex32 } from "../core/brand.js";
import type { WalletApi } from "../wallet/api.js";
import type { AssetInfo } from "../wallet/assets.js";
import type { TransferResult } from "../wallet/result.js";
import { LELANTOS_POOL, SHIELDED_NAMESPACE, shieldedExact, shieldedNetwork } from "./shielded.js";
import type { PaymentRequirements } from "./types.js";

const CHAIN_ID = 31337n;
const RECIPIENT_CM = hex32(`0x${"11".repeat(32)}`);
const CHANGE_CM = hex32(`0x${"22".repeat(32)}`);

const WETH: AssetInfo = {
    id: assetId(1n),
    token: evmAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
    scale: 10n ** 15n,
    disabled: false,
    symbol: "WETH",
    decimals: 18,
};

function stubWallet() {
    const transfer = vi.fn(
        async (): Promise<TransferResult> => ({
            kind: "transfer",
            txHash: hex32(`0x${"fe".repeat(32)}`),
            commitments: [RECIPIENT_CM, CHANGE_CM],
            nonZeroCommitments: [RECIPIENT_CM, CHANGE_CM],
            ownCommitments: [CHANGE_CM],
            ownInflow: circuitAmount(0n),
            spent: ["n1"],
            inputSum: circuitAmount(10_000n),
            sent: circuitAmount(1_500n),
            change: circuitAmount(8_500n),
        }),
    );
    const chainId = vi.fn(async () => CHAIN_ID);
    const asset = vi.fn(async () => WETH);
    return {
        wallet: { chain: { chainId }, asset, transfer } as unknown as WalletApi,
        transfer,
        chainId,
    };
}

const requirements = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
    scheme: "exact",
    network: shieldedNetwork(CHAIN_ID),
    amount: "1500",
    asset: "1",
    payTo: "sswap1qqqq",
    maxTimeoutSeconds: 120,
    extra: { pool: LELANTOS_POOL, paymentFlow: "upfront" },
    ...over,
});

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
        const result = await shieldedExact(wallet).createPaymentPayload(2, requirements());

        expect(transfer).toHaveBeenCalledWith(
            expect.objectContaining({ to: "sswap1qqqq", amount: 1500n, asset: 1n }),
        );
        expect(result).toEqual({
            x402Version: 2,
            payload: {
                pool: LELANTOS_POOL,
                txHash: hex32(`0x${"fe".repeat(32)}`),
                // Output 0 is the recipient's note — output 1 is our change,
                // and quoting it would make the payment unverifiable.
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
            requirements({ amount: "0000001500" }),
        );
        expect(result.payload.amount).toBe("0000001500");
    });

    it("memoises the chain id across quote and payment", async () => {
        const { wallet, chainId } = stubWallet();
        const mechanism = shieldedExact(wallet);
        await mechanism.quote(requirements());
        await mechanism.createPaymentPayload(2, requirements());
        expect(chainId).toHaveBeenCalledTimes(1);
    });

    it("treats a missing `extra.pool` as compatible", async () => {
        const { wallet } = stubWallet();
        await expect(
            shieldedExact(wallet).quote(requirements({ extra: {} })),
        ).resolves.toBeTruthy();
    });
});

describe("shieldedExact.quote", () => {
    it("prices in circuit units, which this network already quotes in", async () => {
        const { wallet, transfer } = stubWallet();
        const quote = await shieldedExact(wallet).quote(requirements());
        expect(quote).toEqual({ amount: 1500n, asset: WETH });
        // Pricing must never move value — the selector calls it on offers it
        // may well discard.
        expect(transfer).not.toHaveBeenCalled();
    });

    const rejects = async (over: Partial<PaymentRequirements>, pattern: RegExp) => {
        const { wallet, transfer } = stubWallet();
        await expect(shieldedExact(wallet).quote(requirements(over))).rejects.toThrow(pattern);
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

    it("honours a caller-supplied minimum window", async () => {
        const { wallet } = stubWallet();
        await expect(
            shieldedExact(wallet, { minTimeoutSeconds: 3 }).quote(
                requirements({ maxTimeoutSeconds: 5 }),
            ),
        ).resolves.toBeTruthy();
    });
});
