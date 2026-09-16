// A mined-and-reverted approval, wrap or permit resolves a receipt like any other; the adapter must
// refuse it, or a setup flow carries on with nothing granted.

import { describe, expect, it } from "vitest";
import { branded, type EvmAddress, type Hex32, type TokenAmount } from "../../core/brand.js";
import type { ViemCtx } from "./ctx.js";
import { permit2PermitAllowanceBatch } from "./permit2.js";
import { tokenApprove, wrapNative } from "./token.js";

const TX = branded<Hex32>(`0x${"11".repeat(32)}`);
const TOKEN = branded<EvmAddress>(`0x${"a1".repeat(20)}`);

function ctxWith(status: "success" | "reverted"): ViemCtx {
    return {
        publicClient: {
            waitForTransactionReceipt: async () => ({ status, blockNumber: 5n, logs: [] }),
        },
        signer: { sendTransaction: async () => TX },
        maspAddress: TOKEN,
        permit2Address: TOKEN,
        chainId: async () => 1n,
    } as unknown as ViemCtx;
}

describe("receipt status", () => {
    const calls = {
        tokenApprove: (ctx: ViemCtx) => tokenApprove(ctx, TOKEN, TOKEN, branded<TokenAmount>(1n)),
        wrapNative: (ctx: ViemCtx) => wrapNative(ctx, TOKEN, 1n),
        permit: (ctx: ViemCtx) =>
            permit2PermitAllowanceBatch(ctx, {
                owner: TOKEN,
                permit: { details: [], spender: TOKEN, sigDeadline: 1n },
                signature: "0x",
            }),
    };

    it.each(Object.entries(calls))("%s: TX_REVERTED on a status-0 receipt", async (_, call) => {
        await expect(call(ctxWith("reverted"))).rejects.toMatchObject({
            code: "TX_REVERTED",
            txHash: TX,
        });
        await expect(call(ctxWith("success"))).resolves.toEqual({ txHash: TX });
    });
});
