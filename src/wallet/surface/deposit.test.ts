// The deposit methods on the wallet object: the operation envelope (`opId`, phases, `state().ops`),
// `awaitDeposit` over the escrow's commitment, and cancel by the returned escrow.

import { describe, expect, it, vi } from "vitest";
import type { ChainAdapter } from "../../chain/port.js";
import type { Permit2SignArgs } from "../../chain/types.js";
import { circuitAmount, evmAddress } from "../../core/brand.js";
import type { DepositRequest } from "../../protocol/deposit-request.js";
import { DEPOSIT_TX, minedDeposit } from "../../test-utils/deposit.js";
import { testWallet } from "../../test-utils/wallet.js";
import type { DepositPhase, PhaseInfo } from "../types/options.js";
import type { WalletState } from "../types/sync.js";

const PAYER = evmAddress(`0x${"aa".repeat(20)}`);

function signingChain() {
    return {
        chainId: async () => 31337n,
        blockNumber: async () => 100,
        maspAddress: async () => evmAddress(`0x${"cc".repeat(20)}`),
        fetchAsset: async () => ({
            token: evmAddress(`0x${"a1".repeat(20)}`),
            scale: 10n,
            disabled: false,
            depositBps: 0n,
            withdrawBps: 0n,
        }),
        tokenMeta: async () => ({ symbol: "T1", decimals: 6 }),
        nativeAdapterAddress: () => undefined,
        payerAddress: async () => PAYER,
        cancelDelay: async () => 3_600,
        permit2Nonce: async () => 1n,
        signPermit2: async (a: Permit2SignArgs) => ({
            nonce: a.nonce,
            deadline: a.deadline,
            maxTotal: a.maxTotal,
            maxFee: 0n,
            signature: "0x",
        }),
        submitDeposit: vi.fn(
            async (a: { deposit: DepositRequest; onSent?: (h: string) => void }) => {
                a.onSent?.(DEPOSIT_TX);
                return minedDeposit(a.deposit, { id: 3n, block: 50 });
            },
        ),
        getEscrowed: async () => ({ digest: DEPOSIT_TX }),
        cancelDeposit: vi.fn(async () => ({
            txHash: DEPOSIT_TX,
            refunded: 1_000n,
            feeAssetId: 0n,
            feeRefunded: 0n,
        })),
    };
}

describe("wallet deposit methods", () => {
    it("runs a deposit as an operation, then awaits and cancels its escrow", async () => {
        const chain = signingChain();
        const { wallet } = await testWallet({ chain: chain as unknown as ChainAdapter });
        const phases: [DepositPhase, PhaseInfo][] = [];
        const ops: WalletState["ops"][] = [];
        const unsubscribe = wallet.subscribe((s) => ops.push(s.ops));

        const res = await wallet.deposit({
            asset: 1n,
            amount: circuitAmount(100n),
            opId: "shield:1",
            onPhase: (p, info) => phases.push([p, info]),
        });
        await Promise.resolve();
        unsubscribe();

        expect(phases.map(([p]) => p)).toEqual([
            "preparing",
            "signing",
            "submitting",
            "broadcast",
            "confirmed",
        ]);
        expect(phases.every(([, i]) => i.opId === "shield:1")).toBe(true);
        expect(res).toMatchObject({
            opId: "shield:1",
            strategy: "witness",
            pulled: [{ baseUnits: 1_000n }],
        });
        expect(res.escrow).toMatchObject({ depositId: 3n, cancellableAtBlock: 3_650 });
        expect(ops.some((o) => o.some((a) => a.opId === "shield:1" && a.op === "deposit"))).toBe(
            true,
        );
        expect(wallet.state().ops).toEqual([]);

        const waited = await wallet.awaitDeposit(res.escrow, { timeoutMs: 0 });
        expect(waited).toMatchObject({ status: "timeout", missing: [res.escrow.commitment] });

        const cancelled = await wallet.cancelDeposit(structuredClone(res.escrow), { opId: "undo" });
        expect(chain.cancelDeposit).toHaveBeenCalledWith(3n, res.escrow.cancelInputs);
        expect(cancelled).toMatchObject({
            kind: "cancelDeposit",
            opId: "undo",
            refunded: { baseUnits: 1_000n, amount: 100n },
            feeRefunded: null,
        });
    });

    it("tags a deposit's error with its opId", async () => {
        const { wallet } = await testWallet({ chain: signingChain() as unknown as ChainAdapter });
        const err = await wallet
            .deposit({ asset: 1n, amount: circuitAmount(1n), feeAsset: "", opId: "x" })
            .catch((e: unknown) => e);
        expect(err).toMatchObject({
            code: "INVALID_ARGUMENT",
            context: { opId: "x", op: "deposit" },
        });
    });
});
