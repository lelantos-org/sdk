// `setupDepositAllowance`: the webapp's Permit2 setup flow, in the SDK.

import { describe, expect, it, vi } from "vitest";
import { assetId, branded, evmAddress, type Hex32 } from "../../core/brand.js";
import { TxRevertedError, UserRejectedError } from "../../errors/chain.js";
import type { PermitBatch } from "../../protocol/deposit-request.js";
import { makeTestCtx } from "../../test-utils/context.js";
import type { AssetInfo } from "../assets/info.js";
import type { AllowanceSetupProgress } from "../types/options.js";
import { ALLOWANCE_CAP, setupDepositAllowance } from "./deposit-allowance.js";

const TOKEN_A = evmAddress(`0x${"a1".repeat(20)}`);
const TOKEN_B = evmAddress(`0x${"b2".repeat(20)}`);
const OWNER = evmAddress(`0x${"aa".repeat(20)}`);
const MASP = evmAddress(`0x${"0c".repeat(20)}`);
const PERMIT2 = evmAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
const hash = (n: number) => branded<Hex32>(`0x${n.toString(16).padStart(64, "0")}`);

/** Asset 1 and 3 share TOKEN_A (a plain and a yield id); asset 2 is TOKEN_B. */
const TOKENS: Record<string, string> = { "1": TOKEN_A, "2": TOKEN_B, "3": TOKEN_A };

async function harness(opts: { erc20?: Record<string, bigint> } = {}) {
    const calls: string[] = [];
    let tx = 0;
    const chain = {
        payerAddress: async () => OWNER,
        signPermit2: async () => ({}),
        maspAddress: async () => MASP,
        permit2Address: () => PERMIT2,
        submitDepositAuthorized: async () => ({}),
        permit2PermitAllowance: async () => ({}),
        signPermit2Allowance: async () => ({}),
        tokenAllowance: vi.fn(async (token: string) => opts.erc20?.[token] ?? 0n),
        tokenApprove: vi.fn(
            async (
                token: string,
                _spender: string,
                _amount: bigint,
                onTxHash?: (h: Hex32) => void,
            ) => {
                calls.push(`approve ${token}`);
                onTxHash?.(hash(++tx));
                return { txHash: hash(tx) };
            },
        ),
        permit2Allowance: vi.fn(async (token: string) => {
            calls.push(`nonce ${token}`);
            return { amount: 0n, expiration: 0, nonce: token === TOKEN_A ? 4 : 9 };
        }),
        signPermit2AllowanceBatch: vi.fn(async (_p: PermitBatch) => {
            calls.push("sign");
            return { signature: "0xsig" };
        }),
        permit2PermitAllowanceBatch: vi.fn(
            async (
                _a: { owner: string; permit: PermitBatch; signature: string },
                onTxHash?: (h: Hex32) => void,
            ) => {
                calls.push("permit");
                onTxHash?.(hash(++tx));
                return { txHash: hash(tx) };
            },
        ),
    };
    const made = await makeTestCtx({
        chain,
        resolveAsset: async (ref) =>
            ({
                id: assetId(BigInt(ref as bigint)),
                token: TOKENS[String(ref)],
            }) as Partial<AssetInfo>,
    });
    return { ...made, chain, calls };
}

describe("setupDepositAllowance", () => {
    it("approves each token below the cap, then signs and permits one batch", async () => {
        const { ctx, chain, calls } = await harness();
        const seen: AllowanceSetupProgress[] = [];
        await setupDepositAllowance(ctx, {
            assets: [1n, 2n, 3n],
            expiration: 2_000_000_000,
            deadline: 1_999_999_999n,
            onProgress: (p) => seen.push(p),
        });

        expect(seen).toEqual([
            { step: "approving", status: "wallet", token: TOKEN_A, index: 1, total: 2 },
            {
                step: "approving",
                status: "confirming",
                txHash: hash(1),
                token: TOKEN_A,
                index: 1,
                total: 2,
            },
            { step: "approving", status: "wallet", token: TOKEN_B, index: 2, total: 2 },
            {
                step: "approving",
                status: "confirming",
                txHash: hash(2),
                token: TOKEN_B,
                index: 2,
                total: 2,
            },
            { step: "signing", status: "wallet" },
            { step: "permitting", status: "wallet" },
            { step: "permitting", status: "confirming", txHash: hash(3) },
        ]);
        // Sequential approvals; nonces read after them, right before the one signature.
        expect(calls).toEqual([
            `approve ${TOKEN_A}`,
            `approve ${TOKEN_B}`,
            `nonce ${TOKEN_A}`,
            `nonce ${TOKEN_B}`,
            "sign",
            "permit",
        ]);
        expect(chain.tokenApprove.mock.calls[0]!.slice(0, 3)).toEqual([
            TOKEN_A,
            PERMIT2,
            (1n << 256n) - 1n,
        ]);
        // Assets 1 and 3 share a token: one window.
        const permit = chain.signPermit2AllowanceBatch.mock.calls[0]![0];
        expect(permit).toEqual({
            details: [
                { token: TOKEN_A, amount: ALLOWANCE_CAP, expiration: 2_000_000_000, nonce: 4 },
                { token: TOKEN_B, amount: ALLOWANCE_CAP, expiration: 2_000_000_000, nonce: 9 },
            ],
            spender: MASP,
            sigDeadline: 1_999_999_999n,
        });
        expect(chain.permit2PermitAllowanceBatch.mock.calls[0]![0]).toEqual({
            owner: OWNER,
            permit,
            signature: "0xsig",
        });
    });

    it("skips tokens already approved to the cap", async () => {
        const { ctx, chain } = await harness({ erc20: { [TOKEN_A]: ALLOWANCE_CAP } });
        const seen: AllowanceSetupProgress[] = [];
        await setupDepositAllowance(ctx, { assets: [1n, 2n], onProgress: (p) => seen.push(p) });
        expect(chain.tokenApprove).toHaveBeenCalledTimes(1);
        expect(chain.tokenApprove.mock.calls[0]![0]).toBe(TOKEN_B);
        expect(seen[0]).toMatchObject({ token: TOKEN_B, index: 1, total: 1 });
        expect(chain.signPermit2AllowanceBatch.mock.calls[0]![0].details).toHaveLength(2);
    });

    it("defaults cap, a 90-day expiration and a 30-minute signature deadline", async () => {
        const { ctx, chain } = await harness();
        const before = Math.floor(Date.now() / 1000);
        await setupDepositAllowance(ctx, { assets: [2n] });
        const permit = chain.signPermit2AllowanceBatch.mock.calls[0]![0];
        expect(permit.details[0]!.amount).toBe(ALLOWANCE_CAP);
        expect(permit.details[0]!.expiration).toBeGreaterThanOrEqual(before + 90 * 86_400);
        expect(permit.sigDeadline).toBeGreaterThanOrEqual(BigInt(before + 1_800));
        expect(permit.sigDeadline).toBeLessThanOrEqual(BigInt(before + 1_801));
    });

    it("stops at a reverted approval (TX_REVERTED) before signing", async () => {
        const { ctx, chain } = await harness();
        chain.tokenApprove.mockRejectedValueOnce(
            new TxRevertedError(hash(1), "tokenApprove: transaction reverted"),
        );
        await expect(setupDepositAllowance(ctx, { assets: [1n] })).rejects.toMatchObject({
            code: "TX_REVERTED",
        });
        expect(chain.signPermit2AllowanceBatch).not.toHaveBeenCalled();
    });

    it("passes a declined signature through as USER_REJECTED", async () => {
        const { ctx, chain } = await harness({ erc20: { [TOKEN_A]: ALLOWANCE_CAP } });
        chain.signPermit2AllowanceBatch.mockRejectedValueOnce(new UserRejectedError("sign-permit"));
        await expect(setupDepositAllowance(ctx, { assets: [1n] })).rejects.toMatchObject({
            code: "USER_REJECTED",
        });
        expect(chain.permit2PermitAllowanceBatch).not.toHaveBeenCalled();
    });

    it("refuses bad terms, an unsupported adapter and a read-only chain before any prompt", async () => {
        const { ctx, chain } = await harness();
        await expect(setupDepositAllowance(ctx, { assets: [1n], cap: 0n })).rejects.toMatchObject({
            argument: "cap",
        });
        await expect(
            setupDepositAllowance(ctx, { assets: [1n], expiration: 1 }),
        ).rejects.toMatchObject({ argument: "expiration" });
        const noBatch = {
            ...ctx,
            cfg: { ...ctx.cfg, chain: { ...chain, signPermit2AllowanceBatch: undefined } },
        };
        await expect(
            setupDepositAllowance(noBatch as never, { assets: [1n] }),
        ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
        const readOnly = { ...ctx, cfg: { ...ctx.cfg, chain: { fetchAsset: async () => ({}) } } };
        await expect(
            setupDepositAllowance(readOnly as never, { assets: [1n] }),
        ).rejects.toMatchObject({ code: "NO_EVM_ACCOUNT" });
        expect(chain.tokenApprove).not.toHaveBeenCalled();
    });
});
