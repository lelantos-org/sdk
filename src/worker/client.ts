// Shared worker RPC client.
//
// One persistent message listener plus an id-keyed pending map, so concurrent
// calls on the same worker stay correlated. Supplies per-call timeouts,
// structured error propagation, and `error`/`messageerror` handling that
// rejects everything in flight rather than leaving it pending forever.

import { emitRecord, getLogger, type LogRecord, loggingConfig } from "../log/logger.js";
import { fromWireError, rpcError } from "./error-wire.js";
import type { MethodMap, RpcControl, RpcRequest, RpcResponse, WorkerLike } from "./types.js";

const log = getLogger("lelantos:worker:rpc");

export interface CallOptions {
    /** Buffers to transfer rather than copy. See the ownership note below. */
    transfer?: readonly unknown[] | undefined;
    /** Overrides the per-method default. */
    timeoutMs?: number | undefined;
    signal?: AbortSignal | undefined;
    /** Merged into the thrown error's context — chunk range, leaf ids, etc. */
    context?: Record<string, unknown> | undefined;
}

export interface WorkerRpcOptions {
    /** Per-method deadline, ms. Methods absent here are not timed out. */
    timeouts?: Record<string, number> | undefined;
    /** Label used in log records. */
    name?: string | undefined;
    /**
     * Handles `{kind:"log"}` records forwarded by the worker. Defaults to
     * replaying them into the local sink, which is what makes worker output
     * visible at all — see the handshake note on {@link RpcControl}.
     */
    onLogRecord?: ((record: unknown) => void) | undefined;
}

export interface WorkerRpc<M extends MethodMap> {
    call<K extends keyof M & string>(
        method: K,
        params: M[K]["params"],
        opts?: CallOptions,
    ): Promise<M[K]["result"]>;
    /** Reject everything in flight and terminate the worker. */
    dispose(reason?: string): void;
    /** False once the worker has crashed or been disposed. */
    readonly alive: boolean;
}

interface Pending {
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
    method: string;
    timer?: ReturnType<typeof setTimeout> | undefined;
    onAbort?: (() => void) | undefined;
    signal?: AbortSignal | undefined;
}

/**
 * Wrap a worker in a typed request/response client.
 *
 * Buffers passed via `opts.transfer` are detached: the caller must not touch
 * them afterwards, and a transferred request can never be re-sent.
 */
export function createWorkerRpc<M extends MethodMap>(
    worker: WorkerLike,
    opts: WorkerRpcOptions = {},
): WorkerRpc<M> {
    const pending = new Map<number, Pending>();
    const name = opts.name ?? "worker";
    let nextId = 1;
    let alive = true;

    const settle = (id: number): Pending | undefined => {
        const p = pending.get(id);
        if (!p) return undefined;
        pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        if (p.onAbort && p.signal) p.signal.removeEventListener("abort", p.onAbort);
        return p;
    };

    const failAll = (mk: (method: string) => Error): void => {
        for (const id of [...pending.keys()]) {
            const p = settle(id);
            p?.reject(mk(p.method));
        }
    };

    const onMessage = (ev: { data: unknown }): void => {
        const msg = ev?.data as RpcResponse | undefined;
        if (!msg) return;
        if ("kind" in msg && msg.kind === "log") {
            if (opts.onLogRecord) opts.onLogRecord(msg.record);
            else emitRecord(msg.record as LogRecord);
            return;
        }
        if (!("id" in msg)) return;
        const p = settle(msg.id);
        if (!p) return; // late response to a timed-out or disposed call
        if (msg.ok) p.resolve(msg.result);
        else p.reject(fromWireError(msg.error));
    };

    const onError = (ev: unknown): void => {
        alive = false;
        const detail = (ev as { message?: string | undefined })?.message ?? "worker error";
        log.error("worker crashed; failing all in-flight calls", {
            name,
            detail,
            inFlight: pending.size,
        });
        failAll((method) =>
            rpcError("WORKER_CRASHED", `${name}: ${detail}`, { method, cause: ev }),
        );
    };

    // A structured-clone failure on the response rejects every in-flight call
    // rather than dropping the message and hanging the caller.
    const onMessageError = (ev: unknown): void => {
        // Marked dead like `onError`. This handler already fails every call in
        // flight, because the id of the undeserialisable response is not
        // recoverable — so continuing to accept new work on a transport that
        // just proved it can silently drop replies is the worst of both.
        alive = false;
        log.error("worker message could not be deserialised", { name });
        failAll((method) =>
            rpcError("WORKER_FAILED", `${name}: response could not be deserialised`, {
                method,
                cause: ev,
            }),
        );
    };

    attach(worker, onMessage, onError, onMessageError, name);

    // See `RpcControl` for why the worker needs this at all. Two facts local to
    // here: posting before the worker script has evaluated is safe because
    // messages queue until its listener is installed, and a later
    // `configureLogging` is not re-propagated — configure before spawning.
    const { level, namespaces } = loggingConfig();
    if (level !== "silent") {
        worker.postMessage({ kind: "log-config", level, namespaces } satisfies RpcControl);
    }

    return {
        get alive() {
            return alive;
        },

        call<K extends keyof M & string>(
            method: K,
            params: M[K]["params"],
            callOpts: CallOptions = {},
        ): Promise<M[K]["result"]> {
            // Captured before the await so the thrown error's stack points
            // at the caller, not at the transport's promise constructor.
            const site = new Error(`worker rpc ${method}`);

            if (!alive) {
                return Promise.reject(
                    rpcError("WORKER_CRASHED", `${name}: worker is no longer running`, {
                        method,
                        site,
                        context: callOpts.context,
                    }),
                );
            }

            // `addEventListener("abort", …)` below never fires on a signal
            // that is already aborted. Without this check the request is
            // posted and stays pending until its method timeout, or forever,
            // since `timeouts` is per-method and optional.
            if (callOpts.signal?.aborted) {
                return Promise.reject(
                    callOpts.signal.reason ?? new Error(`${name}: ${method} aborted`),
                );
            }

            const id = nextId++;
            const timeoutMs = callOpts.timeoutMs ?? opts.timeouts?.[method];

            return new Promise<M[K]["result"]>((resolve, reject) => {
                const entry: Pending = {
                    resolve: resolve as (v: unknown) => void,
                    reject,
                    method,
                };

                if (timeoutMs !== undefined) {
                    entry.timer = setTimeout(() => {
                        settle(id);
                        reject(
                            rpcError("WORKER_TIMEOUT", `${name}: ${method} timed out`, {
                                method,
                                site,
                                context: { ...callOpts.context, timeoutMs },
                            }),
                        );
                    }, timeoutMs);
                }

                if (callOpts.signal) {
                    entry.signal = callOpts.signal;
                    entry.onAbort = () => {
                        settle(id);
                        reject(callOpts.signal?.reason ?? new Error(`${name}: ${method} aborted`));
                    };
                    callOpts.signal.addEventListener("abort", entry.onAbort, { once: true });
                }

                pending.set(id, entry);

                const req: RpcRequest = { id, method, params };
                try {
                    worker.postMessage(req, callOpts.transfer);
                } catch (err) {
                    settle(id);
                    reject(
                        rpcError("WORKER_FAILED", `${name}: could not post ${method}`, {
                            method,
                            cause: err,
                            site,
                            context: callOpts.context,
                        }),
                    );
                }
            }).catch((err) => {
                // Attach call context to remote failures too.
                if (callOpts.context && err && typeof err === "object") {
                    const bag = (err as { context?: Record<string, unknown> | undefined }).context;
                    if (bag) Object.assign(bag, callOpts.context);
                }
                throw err;
            });
        },

        dispose(reason = "disposed"): void {
            alive = false;
            failAll((method) => rpcError("WORKER_CRASHED", `${name}: ${reason}`, { method }));
            worker.terminate();
        },
    };
}

function attach(
    worker: WorkerLike,
    onMessage: (ev: { data: unknown }) => void,
    onError: (ev: unknown) => void,
    onMessageError: (ev: unknown) => void,
    name: string,
): void {
    if (typeof worker.addEventListener === "function") {
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", onError);
        worker.addEventListener("messageerror", onMessageError);
        return;
    }
    // node:worker_threads — an EventEmitter with neither onmessage nor
    // onerror, so assigning `onmessage` would never deliver a message.
    if (typeof worker.on === "function") {
        worker.on("message", (data: unknown) => onMessage({ data }));
        worker.on("error", onError);
        worker.on("messageerror", onMessageError);
        return;
    }
    if ("onmessage" in worker) {
        worker.onmessage = onMessage;
        worker.onerror = onError;
        worker.onmessageerror = onMessageError;
        return;
    }
    throw new Error(
        `${name}: worker exposes neither addEventListener, on, nor onmessage — ` +
            "cannot receive responses",
    );
}
