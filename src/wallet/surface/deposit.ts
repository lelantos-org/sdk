// The deposit methods of the wallet object: `quoteDeposit`, `deposit`, `cancelDeposit` and
// `setupDepositAllowance`.
//
// Loaded on the first call to any of them, and each loads its operation on demand, so a wallet that
// never shields never downloads the deposit builder or the Permit2 flows.

import type { WalletApi } from "../api.js";
import type { DepositPhase, OpOptions } from "../types/options.js";
import type { CancelDepositResult, DepositResult } from "../types/results.js";
import { requireObject, runOp, signalOf } from "./op.js";
import { gated } from "./read.js";
import type { SpendEnv } from "./spend.js";

/** The methods this module implements, as the wallet object exposes them. */
export type DepositMethods = Pick<
    WalletApi,
    "quoteDeposit" | "deposit" | "cancelDeposit" | "setupDepositAllowance"
>;

export function depositMethods(env: SpendEnv): DepositMethods {
    const { ctx, extras } = env;
    const { state } = extras;

    return {
        // A quote is not an operation (`state().ops`), so it runs under the plain read boundary.
        quoteDeposit: (args) =>
            gated(
                state,
                "quoteDeposit",
                async () => {
                    requireObject(args, "quoteDeposit");
                    const { quoteDeposit } = await import("../ops/deposit.js");
                    return quoteDeposit(ctx, args);
                },
                signalOf(args),
            ),

        deposit: (args) =>
            runOp<DepositResult, DepositPhase>(state, "deposit", args, async (run) => {
                requireObject(args, "deposit");
                const { executeDeposit } = await import("../ops/deposit.js");
                return executeDeposit(ctx, args, run);
            }),

        cancelDeposit: (target, opts) =>
            runOp<CancelDepositResult, DepositPhase>(state, "cancelDeposit", opts, async (run) => {
                const { executeCancelDeposit } = await import("../ops/cancel-deposit.js");
                return executeCancelDeposit(ctx, target, run, opts?.signal);
            }),

        setupDepositAllowance: (args) =>
            runOp<void>(state, "setupDepositAllowance", args as OpOptions | undefined, async () => {
                requireObject(args, "setupDepositAllowance");
                const { setupDepositAllowance } = await import("../ops/deposit-allowance.js");
                return setupDepositAllowance(ctx, args);
            }),
    };
}
