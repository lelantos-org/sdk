import { describe, expect, it, vi } from "vitest";
import { assetId, evmAddress, hex32 } from "../core/brand.js";
import {
    shieldedRequirements,
    spendableMaxSpy,
    transferSpy,
    usdc,
    WETH,
    withNsk,
    X402_CHAIN_ID,
} from "../test-utils/x402.js";
import type { WalletApi } from "../wallet/api.js";
import { x402 } from "./fetch.js";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "./types.js";
import { HEADER_PAYMENT_REQUIRED, HEADER_PAYMENT_SIGNATURE } from "./types.js";

const CHAIN_ID = X402_CHAIN_ID;

/** Only the members `x402()` touches. */
function stubWallet(overrides: Partial<WalletApi> = {}): WalletApi {
    return {
        chain: { chainId: async () => CHAIN_ID },
        asset: async () => WETH,
        spendableMax: spendableMaxSpy(),
        transfer: transferSpy(),
        ...overrides,
    } as unknown as WalletApi;
}

function encode(value: unknown): string {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
}

/**
 * The payment payload on a paid retry. The retry is a single `Request` (to
 * reproduce a caller-supplied one), so the header is on the request rather
 * than a separate `init`.
 */
function decodePaymentHeader(input: unknown): PaymentPayload {
    const header = (input as Request).headers?.get(HEADER_PAYMENT_SIGNATURE);
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
        // @ts-expect-error omitting the required option
        expect(() => x402(stubWallet(), {})).toThrow(/budget\.total` is required/);
    });

    it("passes non-402 responses straight through without touching the wallet", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi.fn(async () => new Response("hi", { status: 200 }));
        const pay = x402(wallet, { budget: { total: "5" }, http: { fetch: fetchImpl } });

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

        const pay = x402(wallet, { budget: { total: "5" }, http: { fetch: fetchImpl } });
        const res = await pay("https://api.example.com/premium");

        expect(res.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(wallet.transfer).toHaveBeenCalledWith(
            expect.objectContaining({ recipient: "lelantos1qqqq", amount: 1500n, asset: 1n }),
        );

        const payload = decodePaymentHeader(fetchImpl.mock.calls[1]![0]);
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

    it("pays exactly once when the paid retry fails transiently", async () => {
        // A 5xx after settlement must surface as a 5xx, never as a second
        // payment.
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(paymentRequired([shieldedRequirements()]))
            .mockResolvedValueOnce(new Response("upstream boom", { status: 503 }));

        const pay = x402(wallet, { budget: { total: "5" }, http: { fetch: fetchImpl } });
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

        const pay = x402(wallet, { budget: { total: "5" }, http: { fetch: fetchImpl } });
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

        const pay = x402(wallet, { budget: { total: "5" }, http: { fetch: fetchImpl } });
        await expect(pay("https://api.example.com/premium")).rejects.toThrow(
            /nothing offered by .* is payable/,
        );
        expect(wallet.transfer).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("pays the offer whose asset this wallet actually holds", async () => {
        // A server may price one resource in several assets. Selection walks
        // them in order, so an empty balance in the first must fall through
        // rather than commit the payer to an asset it cannot spend.
        const wallet = stubWallet({ spendableMax: spendableMaxSpy({ 1: 0n, 7: 5_000n }) });
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                paymentRequired([
                    shieldedRequirements({ asset: "1", amount: "1500" }),
                    shieldedRequirements({ asset: "7", amount: "1500" }),
                ]),
            )
            .mockResolvedValueOnce(new Response("premium", { status: 200 }));

        const pay = x402(wallet, { budget: { total: "5" }, http: { fetch: fetchImpl } });
        expect((await pay("https://api.example.com/premium")).status).toBe(200);

        expect(decodePaymentHeader(fetchImpl.mock.calls[1]![0]).accepted.asset).toBe("7");
        expect(wallet.transfer).toHaveBeenCalledWith(
            expect.objectContaining({ asset: 7n, amount: 1500n }),
        );
    });

    it("falls through to the unshielded offer it can fund", async () => {
        // The unshielded mechanism pays from a per-host throwaway address topped
        // up by unshielding. Until it judged that in `quote`, an unfundable
        // first entry aborted the request instead of yielding to the next.
        const BROKE = { ...usdc(7n), token: evmAddress(`0x${"aa".repeat(20)}`) };
        const FUNDED = usdc(8n);
        const wallet = withNsk(
            stubWallet({
                chain: {
                    chainId: async () => CHAIN_ID,
                    tokenBalanceOf: async (token: string) =>
                        token.toLowerCase() === FUNDED.token.toLowerCase() ? 10n ** 12n : 0n,
                },
                asset: async (id: bigint) => (id === 7n ? BROKE : FUNDED),
                // The pool is empty, so the payer with no balance cannot be
                // topped up either.
                spendableMax: spendableMaxSpy({ 7: 0n, 8: 0n }),
            } as unknown as Partial<WalletApi>),
            42n,
        );

        const evmOffer = (token: string) =>
            shieldedRequirements({
                network: `eip155:${CHAIN_ID}`,
                asset: token,
                amount: "10000",
                payTo: "0x0000000000000000000000000000000000000001",
                extra: { name: "USD Coin", version: "2" },
            });
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(paymentRequired([evmOffer(BROKE.token), evmOffer(FUNDED.token)]))
            .mockResolvedValueOnce(new Response("premium", { status: 200 }));

        const pay = x402(wallet, {
            budget: { total: "5" },
            allowUnshielded: true,
            unshielded: { assetIds: [assetId(7n), assetId(8n)] },
            http: { fetch: fetchImpl },
        });

        expect((await pay("https://api.example.com/premium")).status).toBe(200);
        expect(decodePaymentHeader(fetchImpl.mock.calls[1]![0]).accepted.asset).toBe(FUNDED.token);
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
            http: { fetch: fetchImpl },
        });
        await pay("https://api.example.com/premium");

        // The shielded entry is second in `accepts[]` but is still selected.
        expect(decodePaymentHeader(fetchImpl.mock.calls[1]![0]).accepted.network).toBe(
            `shielded:${CHAIN_ID}`,
        );
        expect(wallet.transfer).toHaveBeenCalledTimes(1);
    });

    it("pays an unshielded offer backed by a non-default asset id", async () => {
        // Pricing belongs to the mechanism: if the selector priced eip155 offers
        // against MASP asset 1n, an `assetIds` override would skip every offer.
        const USDC = usdc(7n);
        const wallet = withNsk(
            stubWallet({
                chain: { chainId: async () => CHAIN_ID, tokenBalanceOf: async () => 10n ** 12n },
                // Asset 1n is a different token; only 7n backs this one.
                asset: async (id: bigint) => (id === 7n ? USDC : WETH),
            } as unknown as Partial<WalletApi>),
            42n,
        );

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
            http: { fetch: fetchImpl },
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

        const pay = x402(wallet, { budget: { total: "0.001" }, http: { fetch: fetchImpl } });
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
            http: { fetch: fetchImpl },
        });
        await expect(pay("https://api.example.com/premium")).rejects.toThrow(/not in allowHosts/);
        expect(wallet.transfer).not.toHaveBeenCalled();
    });

    it("refuses a window too short to prove in", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValue(paymentRequired([shieldedRequirements({ maxTimeoutSeconds: 5 })]));

        const pay = x402(wallet, { budget: { total: "5" }, http: { fetch: fetchImpl } });
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

        const pay = x402(wallet, { budget: { total: "5" }, http: { fetch: fetchImpl } });
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
        const pay = x402(wallet, { budget: { total: "5" }, http: { fetch: fetchImpl }, onPayment });
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
            http: { fetch: fetchImpl },
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

        const pay = x402(wallet, { budget: { total: "5" }, http: { fetch: fetchImpl } });
        await expect(pay("https://api.example.com/premium")).rejects.toThrow(
            /without a usable PAYMENT-REQUIRED header/,
        );
    });
});

describe("x402 concurrency and request handling", () => {
    it("enforces the budget across payments that overlap in flight", async () => {
        // Minting a payment takes seconds (prove, then submit); the ledger must
        // count in-flight payments so concurrent calls cannot all pass the check.
        const wallet = stubWallet();
        let release: () => void = () => {};
        const gate = new Promise<void>((r) => {
            release = r;
        });
        const transfer = vi.mocked(wallet.transfer);
        const ok = await transfer({} as never);
        let started = 0;
        transfer.mockImplementation(async () => {
            started++;
            await gate;
            return ok;
        });

        const fetchImpl = vi.fn<typeof fetch>(async () =>
            paymentRequired([shieldedRequirements()]),
        );
        // WETH here is scale 1e15 / 18 decimals, so one payment of 1500
        // circuit units is "1.5". A total of "3" affords exactly two.
        const pay = x402(wallet, { budget: { total: "3" }, http: { fetch: fetchImpl } });

        const calls = [1, 2, 3, 4].map(() =>
            pay("https://api.example.com/premium").catch((e: Error) => e),
        );
        await Promise.resolve();
        await Promise.resolve();
        release();
        const settled = await Promise.all(calls);

        const overBudget = settled.filter(
            (r) => r instanceof Error && /budget/.test(r.message),
        ).length;
        expect(overBudget).toBe(2);
        // The ledger reserved the first two, so only two payments were minted.
        expect(started).toBe(2);
    });

    it("returns the headroom when minting the payment fails", async () => {
        const wallet = stubWallet();
        const transfer = vi.mocked(wallet.transfer);
        const ok = await transfer({} as never);
        transfer.mockRejectedValueOnce(new Error("prover exploded")).mockResolvedValue(ok);

        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(paymentRequired([shieldedRequirements()]))
            .mockResolvedValueOnce(paymentRequired([shieldedRequirements()]))
            .mockResolvedValueOnce(new Response("premium", { status: 200 }));

        // Budget for exactly one payment: a reservation not released on failure
        // would make the retry unaffordable.
        const pay = x402(wallet, { budget: { total: "1.5" }, http: { fetch: fetchImpl } });

        await expect(pay("https://api.example.com/premium")).rejects.toThrow("prover exploded");
        expect((await pay("https://api.example.com/premium")).status).toBe(200);
    });

    it("pays for a POST passed as a Request and preserves its body and headers", async () => {
        const wallet = stubWallet();
        const fetchImpl = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(paymentRequired([shieldedRequirements()]))
            .mockResolvedValueOnce(new Response("premium", { status: 200 }));

        const pay = x402(wallet, { budget: { total: "5" }, http: { fetch: fetchImpl } });
        // The shape both documented integrations use. The first fetch consumes
        // a Request body, so the paid retry must not reuse the same object.
        const req = new Request("https://api.example.com/premium", {
            method: "POST",
            headers: { "content-type": "application/json", "x-caller": "keep-me" },
            body: JSON.stringify({ prompt: "hi" }),
        });

        const res = await pay(req);

        expect(res.status).toBe(200);
        const retried = fetchImpl.mock.calls[1]![0] as Request;
        expect(retried.method).toBe("POST");
        expect(retried.headers.get("x-caller")).toBe("keep-me");
        expect(await retried.text()).toBe(JSON.stringify({ prompt: "hi" }));
        expect(decodePaymentHeader(retried).accepted.network).toBe(`shielded:${CHAIN_ID}`);
    });
});
