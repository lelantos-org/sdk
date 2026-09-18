import { hashTypedData, verifyTypedData } from "viem";

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { assetId, evmAddress } from "../core/brand.js";
import { spendableMaxSpy, usdc, withdrawSpy, withNsk, X402_CHAIN_ID } from "../test-utils/x402.js";
import type { WalletApi } from "../wallet/api.js";
import { deriveEphemeralKey } from "./ephemeral.js";
import type { PaymentRequirements } from "./types.js";
import { unshieldedExact } from "./unshielded.js";

const CHAIN_ID = X402_CHAIN_ID;
const NSK = 12345678901234567890n;
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

const USDC = usdc(1n);

function stubWallet(opts: { balances?: bigint[]; pool?: bigint } = {}) {
    const balances = [...(opts.balances ?? [10_000_000n])];
    const tokenBalanceOf = vi.fn(async () =>
        balances.length > 1 ? balances.shift()! : balances[0],
    );
    const withdraw = withdrawSpy();
    // What the pool could unshield to top the payer up; ample unless a test
    // says otherwise.
    const spendableMax = spendableMaxSpy(opts.pool === undefined ? {} : { 1: opts.pool });
    const wallet = {
        chain: { chainId: async () => CHAIN_ID, tokenBalanceOf },
        asset: async () => USDC,
        assets: async () => [USDC],
        spendableMax,
        withdraw,
    } as unknown as WalletApi;
    withNsk(wallet, NSK);
    return { wallet, tokenBalanceOf, withdraw, spendableMax };
}

const requirements = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
    scheme: "exact",
    network: `eip155:${CHAIN_ID}`,
    amount: "10000",
    asset: USDC.token,
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "USD Coin", version: "2" },
    ...over,
});

describe("unshieldedExact", () => {
    it("signs an EIP-3009 authorization that verifies against the payer", async () => {
        const { wallet } = stubWallet();
        const result = await unshieldedExact(wallet).createPaymentPayload(2, requirements());

        // The EIP-3009 authorization has a fixed field set; each is asserted.
        const payload = result.payload as {
            signature: `0x${string}`;
            authorization: {
                from: string;
                to: string;
                value: string;
                validAfter: string;
                validBefore: string;
                nonce: string;
            };
        };
        const account = privateKeyToAccount(deriveEphemeralKey(NSK, 0));

        expect(payload.authorization.from).toBe(account.address);
        expect(payload.authorization.to).toBe(PAY_TO);
        expect(payload.authorization.value).toBe("10000");
        expect(payload.authorization.validAfter).toBe("0");
        expect(payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);

        // A signature over the wrong domain separator is still well-formed;
        // only verification detects it.
        const valid = await verifyTypedData({
            address: account.address,
            domain: {
                name: "USD Coin",
                version: "2",
                chainId: Number(CHAIN_ID),
                verifyingContract: USDC.token as `0x${string}`,
            },
            types: {
                TransferWithAuthorization: [
                    { name: "from", type: "address" },
                    { name: "to", type: "address" },
                    { name: "value", type: "uint256" },
                    { name: "validAfter", type: "uint256" },
                    { name: "validBefore", type: "uint256" },
                    { name: "nonce", type: "bytes32" },
                ],
            },
            primaryType: "TransferWithAuthorization",
            message: {
                from: account.address,
                to: PAY_TO as `0x${string}`,
                value: 10_000n,
                validAfter: 0n,
                validBefore: BigInt(payload.authorization.validBefore),
                nonce: payload.authorization.nonce as `0x${string}`,
            },
            signature: payload.signature,
        });
        expect(valid).toBe(true);
    });

    it("matches the EIP-712 digest computed independently", async () => {
        // Guards the types tuple and primaryType against unintended edits.
        const digest = hashTypedData({
            domain: {
                name: "USD Coin",
                version: "2",
                chainId: 1,
                verifyingContract: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            },
            types: {
                TransferWithAuthorization: [
                    { name: "from", type: "address" },
                    { name: "to", type: "address" },
                    { name: "value", type: "uint256" },
                    { name: "validAfter", type: "uint256" },
                    { name: "validBefore", type: "uint256" },
                    { name: "nonce", type: "bytes32" },
                ],
            },
            primaryType: "TransferWithAuthorization",
            message: {
                from: "0x0000000000000000000000000000000000000001",
                to: "0x0000000000000000000000000000000000000002",
                value: 1n,
                validAfter: 0n,
                validBefore: 1n,
                nonce: `0x${"00".repeat(32)}`,
            },
        });
        expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("uses a fresh nonce per payment", async () => {
        const { wallet } = stubWallet();
        const mechanism = unshieldedExact(wallet);
        const a = await mechanism.createPaymentPayload(2, requirements());
        const b = await mechanism.createPaymentPayload(2, requirements());
        expect((a.payload as { authorization: { nonce: string } }).authorization.nonce).not.toBe(
            (b.payload as { authorization: { nonce: string } }).authorization.nonce,
        );
    });

    it("derives a different payer per index", async () => {
        const { wallet } = stubWallet();
        const a = await unshieldedExact(wallet, { index: 0 }).createPaymentPayload(
            2,
            requirements(),
        );
        const b = await unshieldedExact(wallet, { index: 1 }).createPaymentPayload(
            2,
            requirements(),
        );
        expect((a.payload as { authorization: { from: string } }).authorization.from).not.toBe(
            (b.payload as { authorization: { from: string } }).authorization.from,
        );
    });

    it("does not unshield when the payer is already funded", async () => {
        const { wallet, withdraw } = stubWallet({ balances: [10_000_000n] });
        await unshieldedExact(wallet).createPaymentPayload(2, requirements());
        expect(withdraw).not.toHaveBeenCalled();
    });

    it("tops up a multiple of the shortfall so one proof covers many calls", async () => {
        // Empty, then funded on the first poll.
        const { wallet, withdraw } = stubWallet({ balances: [0n, 10_000_000n] });
        await unshieldedExact(wallet, { topUpMultiple: 10n, pollMs: 1 }).createPaymentPayload(
            2,
            requirements(),
        );
        // shortfall 10_000 base units × 10, ÷ scale 10^3 = 100 circuit units.
        expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ gross: 100n, asset: 1n }));
    });

    it("tops up with what the pool has when it cannot cover the whole multiple", async () => {
        // The multiple amortises the proof; it is not a requirement. Refusing
        // here would strand a payer holding less than ten calls' worth.
        const { wallet, withdraw } = stubWallet({ balances: [0n, 10_000_000n], pool: 40n });
        await unshieldedExact(wallet, { pollMs: 1 }).createPaymentPayload(2, requirements());
        expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ gross: 40n }));
    });

    it("gives up on a withdrawal that never lands, without signing", async () => {
        const { wallet } = stubWallet({ balances: [0n, 0n, 0n] });
        // The default poll schedule (30 polls, 2 s apart), on a fake clock.
        vi.useFakeTimers();
        try {
            const paying = unshieldedExact(wallet).createPaymentPayload(2, requirements());
            const outcome = expect(paying).rejects.toThrow(/did not land within 60s/);
            await vi.runAllTimersAsync();
            await outcome;
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("unshieldedExact.quote", () => {
    const rejects = async (over: Partial<PaymentRequirements>, pattern: RegExp) => {
        const { wallet, withdraw } = stubWallet();
        await expect(unshieldedExact(wallet).quote(requirements(over))).rejects.toThrow(pattern);
        expect(withdraw).not.toHaveBeenCalled();
    };

    it("converts ERC-20 base units to circuit units for the budget", async () => {
        const { wallet, withdraw } = stubWallet();
        // 10_000 base units ÷ scale 10^3 = 10 circuit units.
        expect(await unshieldedExact(wallet).quote(requirements())).toEqual({
            amount: 10n,
            asset: USDC,
        });
        expect(withdraw).not.toHaveBeenCalled();
    });

    it("rounds the quote up so a budget never under-counts", async () => {
        const { wallet } = stubWallet();
        const quote = await unshieldedExact(wallet).quote(requirements({ amount: "10001" }));
        expect(quote.amount).toBe(11n);
    });

    it("prices a non-default asset id, which the selector must not second-guess", async () => {
        // If the selector re-priced against asset 1n, an `assetIds` override
        // would skip every offer.
        const OTHER = { ...USDC, id: assetId(7n) };
        const wallet = {
            chain: { chainId: async () => CHAIN_ID, tokenBalanceOf: async () => 0n },
            asset: async (id: bigint) =>
                id === 7n
                    ? OTHER
                    : { ...USDC, token: evmAddress("0x000000000000000000000000000000000000dEaD") },
            spendableMax: spendableMaxSpy(),
            withdraw: async () => undefined,
        } as unknown as WalletApi;
        withNsk(wallet, NSK);

        const quote = await unshieldedExact(wallet, { assetIds: [assetId(7n)] }).quote(
            requirements(),
        );
        expect(quote.asset.id).toBe(7n);
    });

    it("refuses another chain — there is no bridge here", () =>
        rejects({ network: "eip155:8453" }, /settles on chain 8453/));

    it("refuses a missing EIP-712 domain", () =>
        rejects({ extra: {} }, /missing `extra.name` \/ `extra.version`/));

    it("refuses an unsupported assetTransferMethod", () =>
        rejects(
            { extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } },
            /assetTransferMethod "permit2" is not supported/,
        ));

    it("refuses a token that is not a registered MASP asset", () =>
        rejects(
            { asset: "0x00000000000000000000000000000000000000ff" },
            /is not a registered MASP asset/,
        ));

    it("resolves the token among registered assets by default, verified against the pool", async () => {
        // The relayer's list names asset 7 for the token; the pool's entry must agree.
        const OTHER = { ...USDC, id: assetId(7n) };
        const listed = { ...USDC, id: assetId(7n) };
        const asset = vi.fn(async (id: bigint) => (id === 7n ? OTHER : USDC));
        const wallet = withNsk(
            {
                chain: { chainId: async () => CHAIN_ID, tokenBalanceOf: async () => 0n },
                assets: async () => [
                    { ...USDC, id: assetId(3n), token: evmAddress(`0x${"0d".repeat(20)}`) },
                    listed,
                ],
                asset,
                spendableMax: spendableMaxSpy(),
            } as unknown as WalletApi,
            NSK,
        );
        const quote = await unshieldedExact(wallet).quote(requirements());
        expect(quote.asset.id).toBe(7n);
        // Only the matching id is verified.
        expect(asset.mock.calls.map(([id]) => id)).toEqual([7n]);
    });

    it("keeps refusing a listed token the pool's entry does not back", async () => {
        const wallet = withNsk(
            {
                chain: { chainId: async () => CHAIN_ID },
                assets: async () => [USDC],
                asset: async () => ({ ...USDC, token: evmAddress(`0x${"0d".repeat(20)}`) }),
            } as unknown as WalletApi,
            NSK,
        );
        await expect(unshieldedExact(wallet).quote(requirements())).rejects.toThrow(
            /is not a registered MASP asset/,
        );
    });

    it("refuses an offer neither the payer nor the pool can fund", async () => {
        // `unsupported-requirements`, so `select` moves to the next entry. The
        // same refusal from `createPaymentPayload` would abort the request.
        const { wallet, withdraw } = stubWallet({ balances: [0n], pool: 9n });
        await expect(unshieldedExact(wallet).quote(requirements())).rejects.toThrow(
            /payer 0x\w+ holds 0 of the 10000 base unit\(s\).*pool can add only 9 of the 10/,
        );
        expect(withdraw).not.toHaveBeenCalled();
    });

    it("accepts an offer the pool can cover, even with the payer empty", async () => {
        const { wallet, withdraw } = stubWallet({ balances: [0n], pool: 10n });
        await expect(unshieldedExact(wallet).quote(requirements())).resolves.toBeTruthy();
        // Pricing must not move value: the top-up belongs to the payment.
        expect(withdraw).not.toHaveBeenCalled();
    });

    it("refuses when the adapter cannot read the payer's balance", async () => {
        const wallet = withNsk(
            {
                chain: { chainId: async () => CHAIN_ID },
                asset: async () => USDC,
                assets: async () => [USDC],
            } as unknown as WalletApi,
            NSK,
        );
        // Static, so it is answered here rather than per payment.
        await expect(unshieldedExact(wallet).quote(requirements())).rejects.toThrow(
            /chain adapter has no `tokenBalanceOf`/,
        );
    });

    it("judges the payer the payment will actually use", async () => {
        // Payer slots are per host, so a quote that ignored the host would read
        // a different address than the one `createPaymentPayload` funds.
        const seen: string[] = [];
        const wallet = withNsk(
            {
                chain: {
                    chainId: async () => CHAIN_ID,
                    tokenBalanceOf: async (_token: unknown, payer: string) => {
                        seen.push(payer);
                        return 10_000_000n;
                    },
                },
                asset: async () => USDC,
                assets: async () => [USDC],
                spendableMax: spendableMaxSpy(),
                withdraw: withdrawSpy(),
            } as unknown as WalletApi,
            NSK,
        );
        const mechanism = unshieldedExact(wallet);

        await mechanism.quote(requirements(), { host: "a.example" });
        await mechanism.createPaymentPayload(2, requirements(), { host: "a.example" });
        expect(new Set(seen).size).toBe(1);

        await mechanism.quote(requirements(), { host: "b.example" });
        expect(new Set(seen).size).toBe(2);
    });

    it("refuses a non-integer amount", () =>
        rejects({ amount: "1.5" }, /amount must be a decimal integer/));
});

describe("unshieldedExact funding concurrency", () => {
    it("tops a payer up once for concurrent payments to the same slot", async () => {
        // Without serialisation, each payment reads the pre-top-up balance and
        // withdraws, producing several withdrawals for one shortfall.
        let funded = false;
        const tokenBalanceOf = vi.fn(async () => (funded ? 10_000_000n : 0n));
        const withdraw = vi.fn(async () => {
            funded = true;
            return {} as never;
        });
        const wallet = {
            chain: { chainId: async () => CHAIN_ID, tokenBalanceOf },
            asset: async () => USDC,
            assets: async () => [USDC],
            spendableMax: spendableMaxSpy(),
            withdraw,
        } as unknown as WalletApi;
        withNsk(wallet, NSK);

        const mechanism = unshieldedExact(wallet, { pollMs: 1 });
        await Promise.all([
            mechanism.createPaymentPayload(2, requirements()),
            mechanism.createPaymentPayload(2, requirements()),
            mechanism.createPaymentPayload(2, requirements()),
        ]);

        expect(withdraw).toHaveBeenCalledTimes(1);
    });

    it("funds distinct payer slots in parallel", async () => {
        // Slots are separate addresses, so the lock is per slot and two hosts
        // do not queue behind each other.
        let inFlight = 0;
        let peak = 0;
        const balances = new Map<string, bigint>();
        const tokenBalanceOf = vi.fn(
            async (_token: unknown, payer: string) => balances.get(payer) ?? 0n,
        );
        const withdraw = vi.fn(async (args: { recipient: string }) => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5_000));
            balances.set(args.recipient, 10_000_000n);
            inFlight--;
            return {} as never;
        });
        const wallet = {
            chain: { chainId: async () => CHAIN_ID, tokenBalanceOf },
            asset: async () => USDC,
            assets: async () => [USDC],
            spendableMax: spendableMaxSpy(),
            withdraw,
        } as unknown as WalletApi;
        withNsk(wallet, NSK);

        const mechanism = unshieldedExact(wallet);
        vi.useFakeTimers();
        try {
            const paid = Promise.all([
                mechanism.createPaymentPayload(2, requirements(), { host: "a.example" }),
                mechanism.createPaymentPayload(2, requirements(), { host: "b.example" }),
            ]);
            await vi.runAllTimersAsync();
            await paid;
        } finally {
            vi.useRealTimers();
        }

        expect(peak).toBe(2);
    });

    it("reports a top-up before the value leaves the pool", async () => {
        // `topUpMultiple` moves more than one payment costs, and a poll timeout
        // leaves no other record.
        const seen: Array<{ amount: bigint }> = [];
        const { wallet } = stubWallet({ balances: [0n, 0n, 0n] });

        await expect(
            unshieldedExact(wallet, {
                pollMs: 1,
                maxPolls: 1,
                onTopUp: (info) => seen.push(info),
            }).createPaymentPayload(2, requirements()),
        ).rejects.toThrow(/did not land within/);

        expect(seen).toHaveLength(1);
        expect(seen[0]?.amount).toBeGreaterThan(0n);
    });
});
