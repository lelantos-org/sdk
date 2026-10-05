// `genericCall(wallet, request)`: a `GenericCallWrapper` execution on a wallet `connect()` or
// `createWallet()` returned. Published at `./internal` for e2e harnesses and dev scripts; carries
// no stability guarantee. Wallet operations that use the wrapper call `tx/generic-call.ts`
// directly.

import type { TokenAmount } from "../../core/brand.js";
import { InvalidArgumentError } from "../../errors/config.js";
import type { GenericCall } from "../../protocol/transact.js";
import type { WalletApi } from "../api.js";
import { type OutAmount, resolveOutAmount } from "../assets/amount.js";
import type { AssetRef } from "../assets/asset-ref.js";
import type { GenericCallResult } from "../tx/generic-call.js";
import { shieldedRecipient } from "../tx/recipient.js";
import type { SpendOptions } from "../types/options.js";
import { walletContext } from "./internals.js";

/** One note the calls must produce. */
export interface GenericCallOutput {
    asset: AssetRef;
    /** Token base units the calls return to the wrapper in `asset`'s token. */
    tokens: bigint;
    /**
     * `"floor"`: `tokens` is a lower bound and the note is the smallest whose pull covers it.
     * `"exact"`: the calls return exactly `tokens` and the note is the largest whose pull fits.
     */
    sizing: "floor" | "exact";
    /** Default: the wallet's own address. */
    recipient?: string | undefined;
}

export interface GenericCallRequest {
    /** The asset unshielded to the wrapper. */
    asset: AssetRef;
    /** What leaves the pool (`gross`) or what the wrapper receives (`net`). */
    amount: OutAmount;
    calls: readonly GenericCall[];
    /** One to four, of distinct tokens. Omitted: the whole input, returned untouched. */
    outputs?: readonly GenericCallOutput[] | undefined;
    /** Gas the call leg must be forwarded. */
    minGas: bigint;
    refundTo?: string | undefined;
    surplusTo?: string | undefined;
    deadline?: bigint | undefined;
}

/**
 * Unshield `amount` to `GenericCallWrapper`, run `calls` from its single-use clone, and re-shield
 * `outputs`. If the calls fail the input is re-shielded as the refund note instead.
 *
 * Resolves once the relayer has landed the execution. The output notes, or the refund note, appear
 * after the relayer's next flush: await `outputCommitments` and `refundCommitment` together with
 * `wallet.awaitCommitments` and see which arrives.
 *
 * @throws {InvalidArgumentError} when `wallet` was not built by `connect()` or `createWallet()`.
 */
export async function genericCall(
    wallet: WalletApi,
    request: GenericCallRequest,
    options: Omit<SpendOptions, "onPhase" | "opId"> = {},
): Promise<GenericCallResult> {
    const ctx = walletContext(wallet);
    if (!ctx) {
        throw new InvalidArgumentError(
            "genericCall: not a spending wallet built by connect() or createWallet()",
            { argument: "wallet" },
        );
    }
    const op = "genericCall";
    const asset = await ctx.assets.resolveVerified(request.asset);
    const out = resolveOutAmount(request.amount, asset, op);
    const outputs = await Promise.all(
        (
            request.outputs ?? [{ asset: request.asset, tokens: out.net, sizing: "exact" as const }]
        ).map(async (o) => ({
            asset: await ctx.assets.resolveVerified(o.asset),
            tokens: o.tokens as TokenAmount,
            sizing: o.sizing,
            recipient:
                o.recipient === undefined
                    ? ctx.ownAddress
                    : shieldedRecipient(ctx.J, o.recipient, op).decoded,
        })),
    );
    // Loaded with the spend that needs it.
    const [{ executeGenericCall }, { detachedRun }] = await Promise.all([
        import("../tx/generic-call.js"),
        import("../tx/run-spend.js"),
    ]);
    return executeGenericCall(
        ctx,
        {
            op,
            asset,
            out,
            calls: request.calls,
            outputs,
            minGas: request.minGas,
            refundTo: request.refundTo,
            surplusTo: request.surplusTo,
            deadline: request.deadline,
        },
        options,
        detachedRun(op),
    );
}
