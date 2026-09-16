// Classify what the viem adapter's calls throw.
//
// viem raises its own error classes (transport, revert, receipt timeout), and a
// browser wallet behind an EIP-1193 provider raises `{ code: 4001 }`. The
// adapter is the boundary where those become `WalletError`s, so everything above
// it branches on `code`.

import { causeChain } from "../../errors/base.js";
import {
    asUserRejection,
    ChainRpcError,
    TxMiningError,
    type UserRejectedAction,
} from "../../errors/chain.js";
import { isWalletError } from "../../errors/guard.js";
import { isContractRevert } from "../revert.js";

/** Whether an `Error` named `name` is on `err`'s cause chain. */
function hasName(err: unknown, name: string): boolean {
    for (const cur of causeChain(err)) {
        if (!(cur instanceof Error)) return false;
        if (cur.name === name) return true;
    }
    return false;
}

/**
 * The `WalletError` for a failure of adapter method `method`.
 *
 *   - already a `WalletError` → unchanged;
 *   - a wallet's rejection → `UserRejectedError` for `action` (default `send-tx`);
 *   - viem's receipt timeout → `TxMiningError` (retryable);
 *   - anything else → `ChainRpcError`, retryable unless the node answered with a revert.
 */
export function chainError(
    method: string,
    err: unknown,
    action: UserRejectedAction = "send-tx",
): unknown {
    if (isWalletError(err)) return err;
    const rejected = asUserRejection(err, action);
    if (rejected !== err) return rejected;
    if (hasName(err, "WaitForTransactionReceiptTimeoutError")) {
        return new TxMiningError(`${method}: transaction receipt did not arrive in time`, {
            cause: err,
        });
    }
    return new ChainRpcError(method, { cause: err, retryable: !isContractRevert(err) });
}

/** Run one adapter call, classifying its failure with {@link chainError}. */
export async function chainCall<T>(
    method: string,
    fn: () => Promise<T>,
    action?: UserRejectedAction,
): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        throw chainError(method, err, action);
    }
}
