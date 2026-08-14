import { describe, expect, it, vi } from "vitest";
import { assetId, circuitAmount, evmAddress, hex32 } from "../core/brand.js";
import type { WalletApi } from "../wallet/api.js";
import type { AssetInfo } from "../wallet/assets.js";
import type { TransferResult } from "../wallet/result.js";
import { x402 } from "./fetch.js";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "./types.js";
import { HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_SIGNATURE } from "./types.js";

const CHAIN_ID = 31337n;

const WETH: AssetInfo = {
    id: assetId(1n),
    token: evmAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
    scale: 10n ** 15n,
    disabled: false,
    symbol: "WETH",
    decimals: 18,
};

/** Only the members `x402()` touches. */
function stubWallet(overrides: Partial<WalletApi> = {}): WalletApi {
    const transfer = vi.fn(
        async (): Promise<TransferResult> => ({
            kind: "transfer",
            txHash: hex32(`0x${"de".repeat(32)}`),
            commitments: [hex32(`0x${"11".repeat(32)}`), hex32(`0x${"22".repeat(32)}`)],
            nonZeroCommitments: [hex32(`0x${"11".repeat(32)}`), hex32(`0x${"22".repeat(32)}`)],
            ownCommitments: [hex32(`0x${"22".repeat(32)}`)],
            ownInflow: circuitAmount(0n),
            spent: ["n1"],
            inputSum: circuitAmount(10_000n),
            sent: circuitAmount(1_500n),
            change: circuitAmount(8_500n),
        }),
    );
    return {
        chain: { chainId: async () => CHAIN_ID },
        asset: async () => WETH,
        transfer,
        ...overrides,
    } as unknown as WalletApi;
}

function shieldedRequirements(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
    return {
        scheme: "exact",
        network: `shielded:${CHAIN_ID}`,
        amount: "1500",
        asset: "1",
        payTo: "sswap21qqqq",
        maxTimeoutSeconds: 120,
        extra: { pool: "lelantos", paymentFlow: "upfront" },
        ...over,
    };
}

function encode(value: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

function decodePaymentHeader(init: RequestInit | undefined): PaymentPayload {
    const header = new Headers(init?.headers).get(HEADER_PAYMENT_SIGNATURE);
    if (!header) throw new Error("no payment header");
    const binary = atob(header);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as PaymentPayload;
}

function paymentRequired(accepts: PaymentRequirements[]): Response {
    return new Response("payment required", {
        status: 402,
        headers: {
            [HEADER_PAYMENT_REQUIRED]: encode({
                x402Version: 2,
                accepts,
                resource: { url: "https://api.example.com/premium" },
            } satisfies PaymentRequired),
        },
    });
}

describe("x402", () => {
    it("requires a budget", () => {
        // @ts-expect-error deliberately omitting the required option
        expect(() => x402(stubWallet(), {})).toThrow(/budget\.total` is required/);
    });

    it("passes non-402 responses straight through without touching the wallet", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi.fn(async () => new Response("hi", { status: 200 }));
        const pay = x402(wallet, { budget: { total: "5" }, fetchImpl });

        expect(await (await pay("https://api.example.com/free")).text()).toBe("hi");
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(wallet.transfer).not.toHaveBeenCalled();
    });

    it("pays a shielded 402 and retries once", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(paymentRequired([shieldedRequirements()]))
            .mockResolvedValueOnce(new Response("premium", { status: 200 }));

        const pay = x402(wallet, { budget: { total: "5" }, fetchImpl });
        const res = await pay("https://api.example.com/premium");

        expect(res.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(wallet.transfer).toHaveBeenCalledWith(
            expect.objectContaining({ to: "sswap21qqqq", amount: 1500n, asset: 1n }),
        );

        const payload = decodePaymentHeader(fetchImpl.mock.calls[1]![1]);
        expect(payload.x402Version).toBe(2);
        expect(payload.accepted.network).toBe(`shielded:${CHAIN_ID}`);
        expect(payload.payload).toEqual({
            pool: "lelantos",
            txHash: hex32(`0x${"de".repeat(32)}`),
            commitment: `0x${"11".repeat(32)}`,
            asset: "1",
            amount: "1500",
        });
    });

    it("accepts a 402 that puts PaymentRequired in the body", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ x402Version: 2, accepts: [shieldedRequirements()] }),
                    {
                        status: 402,
                        headers: { "content-type": "application/json" },
                    },
                ),
            )
            .mockResolvedValueOnce(new Response("premium", { status: 200 }));

        const pay = x402(wallet, { budget: { total: "5" }, fetchImpl });
        expect((await pay("https://api.example.com/premium")).status).toBe(200);
        expect(wallet.transfer).toHaveBeenCalledTimes(1);
    });

    it("pays exactly once when the paid retry fails transiently", async () => {
        // The double-pay hazard: a 5xx after settlement must surface as a 5xx,
        // never as a second payment.
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(paymentRequired([shieldedRequirements()]))
            .mockResolvedValueOnce(new Response("upstream boom", { status: 503 }));

        const pay = x402(wallet, { budget: { total: "5" }, fetchImpl });
        const res = await pay("https://api.example.com/premium");

        expect(res.status).toBe(503);
        expect(wallet.transfer).toHaveBeenCalledTimes(1);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("does not pay twice when the server 402s again", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(paymentRequired([shieldedRequirements()]));

        const pay = x402(wallet, { budget: { total: "5" }, fetchImpl });
        await expect(pay("https://api.example.com/premium")).rejects.toThrow(
            /returned 402 again after payment/,
        );
        expect(wallet.transfer).toHaveBeenCalledTimes(1);
    });

    it("refuses an unshielded-only server by default", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
            paymentRequired([
                shieldedRequirements({
                    network: `eip155:${CHAIN_ID}`,
                    asset: WETH.token,
                    payTo: "0x0000000000000000000000000000000000000001",
                    extra: { name: "WETH", version: "1" },
                }),
            ]),
        );

        const pay = x402(wallet, { budget: { total: "5" }, fetchImpl });
        await expect(pay("https://api.example.com/premium")).rejects.toThrow(
            /nothing offered by .* is payable/,
        );
        expect(wallet.transfer).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("prefers the shielded offer when both are on the table", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                paymentRequired([
                    shieldedRequirements({
                        network: `eip155:${CHAIN_ID}`,
                        asset: WETH.token,
                        payTo: "0x0000000000000000000000000000000000000001",
                        extra: { name: "WETH", version: "1" },
                    }),
                    shieldedRequirements(),
                ]),
            )
            .mockResolvedValueOnce(new Response("premium", { status: 200 }));

        const pay = x402(wallet, {
            budget: { total: "5" },
            allowUnshielded: true,
            fetchImpl,
        });
        await pay("https://api.example.com/premium");

        // The shielded entry is second in `accepts[]` but must still win.
        expect(decodePaymentHeader(fetchImpl.mock.calls[1]![1]).accepted.network).toBe(
            `shielded:${CHAIN_ID}`,
        );
        expect(wallet.transfer).toHaveBeenCalledTimes(1);
    });

    it("pays an unshielded offer backed by a non-default asset id", async () => {
        // Pricing belongs to the mechanism: a selector that priced eip155
        // offers itself against MASP asset 1n would skip every offer under an
        // `assetIds` override.
        const USDC: AssetInfo = {
            id: assetId(7n),
            token: evmAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
            scale: 10n ** 3n,
            disabled: false,
            symbol: "USDC",
            decimals: 6,
        };
        const wallet = stubWallet({
            keys: { nsk: 42n },
            chain: { chainId: async () => CHAIN_ID, tokenBalanceOf: async () => 10n ** 12n },
            // Asset 1n is something else entirely — only 7n backs the token.
            asset: async (id: bigint) => (id === 7n ? USDC : WETH),
        } as unknown as Partial<WalletApi>);

        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                paymentRequired([
                    shieldedRequirements({
                        network: `eip155:${CHAIN_ID}`,
                        asset: USDC.token,
                        amount: "10000",
                        payTo: "0x0000000000000000000000000000000000000001",
                        extra: { name: "USD Coin", version: "2" },
                    }),
                ]),
            )
            .mockResolvedValueOnce(new Response("premium", { status: 200 }));

        const pay = x402(wallet, {
            budget: { total: "5" },
            allowUnshielded: true,
            unshielded: { assetIds: [assetId(7n)] },
            fetchImpl,
        });

        expect((await pay("https://api.example.com/premium")).status).toBe(200);
        // 10_000 base units ÷ scale 10^3 = 10 circuit units, booked to asset 7.
        expect(pay.spent()).toEqual(new Map([[7n, 10n]]));
    });

    it("stops on a budget breach without paying", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(paymentRequired([shieldedRequirements({ amount: "999999999" })]));

        const pay = x402(wallet, { budget: { total: "0.001" }, fetchImpl });
        await expect(pay("https://api.example.com/premium")).rejects.toThrow(/per-request limit/);
        expect(wallet.transfer).not.toHaveBeenCalled();
    });

    it("stops on a disallowed host before reading the offer", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(paymentRequired([shieldedRequirements()]));

        const pay = x402(wallet, {
            budget: { total: "5" },
            allowHosts: ["trusted.example.com"],
            fetchImpl,
        });
        await expect(pay("https://api.example.com/premium")).rejects.toThrow(/not in allowHosts/);
        expect(wallet.transfer).not.toHaveBeenCalled();
    });

    it("refuses a window too short to prove in", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(paymentRequired([shieldedRequirements({ maxTimeoutSeconds: 5 })]));

        const pay = x402(wallet, { budget: { total: "5" }, fetchImpl });
        await expect(pay("https://api.example.com/premium")).rejects.toThrow(
            /nothing offered by .* is payable/,
        );
        expect(wallet.transfer).not.toHaveBeenCalled();
    });

    it("refuses an offer settling on another chain", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(
                paymentRequired([shieldedRequirements({ network: "shielded:8453" })]),
            );

        const pay = x402(wallet, { budget: { total: "5" }, fetchImpl });
        await expect(pay("https://api.example.com/premium")).rejects.toThrow(
            /nothing offered by .* is payable/,
        );
    });

    it("tracks spend and reports it", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(paymentRequired([shieldedRequirements()]))
            .mockResolvedValueOnce(new Response("ok", { status: 200 }));

        const onPayment = vi.fn();
        const pay = x402(wallet, { budget: { total: "5" }, fetchImpl, onPayment });
        expect(pay.spent().size).toBe(0);

        await pay("https://api.example.com/premium");

        expect(pay.spent()).toEqual(new Map([[1n, 1500n]]));
        expect(onPayment).toHaveBeenCalledWith(
            expect.objectContaining({ url: "https://api.example.com/premium", unshielded: false }),
        );
    });

    it("survives a throwing onPayment hook", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(paymentRequired([shieldedRequirements()]))
            .mockResolvedValueOnce(new Response("ok", { status: 200 }));

        const pay = x402(wallet, {
            budget: { total: "5" },
            fetchImpl,
            onPayment: () => {
                throw new Error("audit sink down");
            },
        });
        expect((await pay("https://api.example.com/premium")).status).toBe(200);
    });

    it("rejects a 402 with no usable offer document", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response("nope", { status: 402 }));

        const pay = x402(wallet, { budget: { total: "5" }, fetchImpl });
        await expect(pay("https://api.example.com/premium")).rejects.toThrow(
            /without a usable PAYMENT-REQUIRED header/,
        );
    });
});
