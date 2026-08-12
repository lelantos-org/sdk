import { hashTypedData, verifyTypedData } from "viem";

import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { assetId, circuitAmount, evmAddress, hex32 } from "../core/brand.js";
import type { WalletApi } from "../wallet/api.js";
import type { AssetInfo } from "../wallet/assets.js";
import type { WithdrawResult } from "../wallet/result.js";
import { deriveEphemeralKey } from "./ephemeral.js";
import type { PaymentRequirements } from "./types.js";
import { unshieldedExact } from "./unshielded.js";

const CHAIN_ID = 31337n;
const NSK = 12345678901234567890n;
const PAY_TO = "0x209693Bc6afc0C5328bA36FaF03C514EF312287C";

/** 6-decimal token, scale 10^3 → one circuit unit is 0.001 USDC. */
const USDC: AssetInfo = {
    id: assetId(1n),
    token: evmAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
    scale: 10n ** 3n,
    disabled: false,
    symbol: "USDC",
    decimals: 6,
};

function stubWallet(opts: { balances?: bigint[] } = {}) {
    const balances = [...(opts.balances ?? [10_000_000n])];
    const tokenBalanceOf = vi.fn(async () =>
        balances.length > 1 ? balances.shift()! : balances[0],
    );
    const withdraw = vi.fn(
        async (): Promise<WithdrawResult> => ({
            kind: "withdraw",
            txHash: hex32(`0x${"ff".repeat(32)}`),
            commitments: [hex32(`0x${"11".repeat(32)}`), hex32(`0x${"22".repeat(32)}`)],
            nonZeroCommitments: [],
            ownCommitments: [],
            ownInflow: circuitAmount(0n),
            spent: [],
            inputSum: circuitAmount(0n),
            sent: circuitAmount(0n),
            change: circuitAmount(0n),
        }),
    );
    const wallet = {
        keys: { nsk: NSK },
        chain: { chainId: async () => CHAIN_ID, tokenBalanceOf },
        asset: async () => USDC,
        withdraw,
    } as unknown as WalletApi;
    return { wallet, tokenBalanceOf, withdraw };
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

        // Named rather than `Record<string, string>`: the EIP-3009
        // authorization has a fixed field set, and the test asserts each one.
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

        // A signature computed against the wrong domain separator is still
        // well-formed, so only verification catches it.
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
        // Guards the types tuple and primaryType against silent edits.
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
        expect(withdraw).toHaveBeenCalledWith(expect.objectContaining({ amount: 100n, asset: 1n }));
    });

    it("gives up on a withdrawal that never lands, without signing", async () => {
        const { wallet } = stubWallet({ balances: [0n, 0n, 0n] });
        await expect(
            unshieldedExact(wallet, { pollMs: 1, maxPolls: 2 }).createPaymentPayload(
                2,
                requirements(),
            ),
        ).rejects.toThrow(/did not land within/);
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
        // Re-deriving the price against asset 1n in the selector would make
        // any `assetIds` override skip every offer.
        const OTHER = { ...USDC, id: assetId(7n) };
        const wallet = {
            keys: { nsk: NSK },
            chain: { chainId: async () => CHAIN_ID, tokenBalanceOf: async () => 0n },
            asset: async (id: bigint) =>
                id === 7n
                    ? OTHER
                    : { ...USDC, token: evmAddress("0x000000000000000000000000000000000000dEaD") },
            withdraw: async () => undefined,
        } as unknown as WalletApi;

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
            /is not among the MASP assets/,
        ));

    it("refuses a non-integer amount", () =>
        rejects({ amount: "1.5" }, /amount must be a decimal integer/));
});
