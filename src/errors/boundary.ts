// The public-method boundary: nothing but a `WalletError` (or the caller's own
// abort reason) leaves a wallet method.

import { errMessage, InternalError } from "./base.js";
import { isWalletError } from "./guard.js";

/**
 * Run the body of a public async method so every rejection is a `WalletError`.
 *
 * A `WalletError` passes through with `context.op` filled in if absent. The
 * reason of the caller's `signal` passes through unchanged, like `fetch` does,
 * so `err === signal.reason` holds. Anything else (a plugin's bare `Error`, a
 * `TypeError` from a bug) becomes {@link InternalError} with the original as
 * `cause`.
 */
export async function boundary<T>(
    op: string,
    fn: () => Promise<T> | T,
    signal?: AbortSignal | undefined,
): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        if (signal?.aborted && err === signal.reason) throw err;
        if (isWalletError(err)) {
            if (err.context) err.context.op ??= op;
            throw err;
        }
        // The original message is kept: it is what escaped before this boundary
        // existed, and applications word advice from it (a wallet's "nonce too low").
        throw new InternalError(`${op}: unexpected failure (see \`cause\`): ${errMessage(err)}`, {
            cause: err,
            context: { op },
        });
    }
}
