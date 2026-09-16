// Worker RPC errors.

import { WalletError, type WalletErrorOptions } from "./base.js";

export type WorkerErrorCode = "WORKER_TIMEOUT" | "WORKER_CRASHED" | "WORKER_FAILED";

/**
 * A worker RPC call failed. `cause` carries the reconstructed remote error,
 * whose `stack` is the one from inside the worker; this error's own stack is
 * the call site on the main thread.
 *
 * Generic in its code for the same reason as `NetworkError`.
 */
export class WorkerRpcError<C extends WorkerErrorCode = WorkerErrorCode> extends WalletError<C> {
    readonly method?: string | undefined;
    constructor(
        code: C,
        message: string,
        opts?: WalletErrorOptions & { method?: string | undefined },
    ) {
        // A timed-out call may succeed on a less loaded worker; a crash or a
        // remote failure repeats.
        super(code, message, { ...opts, retryable: code === "WORKER_TIMEOUT" });
        this.name = "WorkerRpcError";
        this.method = opts?.method;
    }
}
