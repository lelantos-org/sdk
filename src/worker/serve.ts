// Worker-side RPC dispatch.
//
// Owns error normalisation for every worker entrypoint, and rejects unknown
// methods explicitly rather than dropping the message and hanging the caller.

import { configureLogging, type LogRecord } from "../log/logger.js";
import { toWireError } from "./error-wire.js";
import type { MethodMap, RpcRequest, RpcResponse, WorkerScopeLike } from "./types.js";

export type Handlers<M extends MethodMap> = {
    [K in keyof M]: (params: M[K]["params"]) => Promise<M[K]["result"]> | M[K]["result"];
};

export interface ServeOptions<M extends MethodMap> {
    /** Defaults to the worker global. */
    scope?: WorkerScopeLike;
    /** Buffers to transfer back with a result. */
    transferablesOf?: (method: keyof M & string, result: unknown) => readonly unknown[];
    /**
     * Forward log records to the client so worker output lands in the app's
     * sink. Browser worker `console` goes to a separate devtools context and
     * Node worker output is interleaved and unattributed, so without this
     * worker logs are effectively invisible.
     */
    forwardLogs?: boolean;
    /** Cap on forwarded records per second; excess is dropped. Default 200. */
    logRateLimit?: number;
}

/** Install the message handler. Call once, at worker top level. */
export function serveWorkerRpc<M extends MethodMap>(
    handlers: Handlers<M>,
    opts: ServeOptions<M> = {},
): void {
    const scope = opts.scope ?? (globalThis as unknown as WorkerScopeLike);

    if (opts.forwardLogs) installLogForwarder(scope, opts.logRateLimit ?? 200);

    const onMessage = async (ev: { data: unknown }): Promise<void> => {
        const req = ev?.data as RpcRequest | undefined;
        if (!req || typeof req.id !== "number" || typeof req.method !== "string") return;

        const handler = handlers[req.method as keyof M];
        if (!handler) {
            post(scope, {
                id: req.id,
                ok: false,
                error: {
                    name: "WorkerRpcError",
                    message: `unknown method "${req.method}"`,
                    code: "WORKER_FAILED",
                },
            });
            return;
        }

        try {
            const result = await handler(req.params);
            const transfer = opts.transferablesOf?.(req.method as keyof M & string, result);
            post(scope, { id: req.id, ok: true, result }, transfer);
        } catch (err) {
            post(scope, { id: req.id, ok: false, error: toWireError(err) });
        }
    };

    if (typeof scope.addEventListener === "function") {
        scope.addEventListener("message", onMessage);
    } else {
        scope.onmessage = onMessage;
    }
}

function post(scope: WorkerScopeLike, msg: RpcResponse, transfer?: readonly unknown[]): void {
    scope.postMessage(msg, transfer);
}

function installLogForwarder(scope: WorkerScopeLike, perSecond: number): void {
    let windowStart = 0;
    let sent = 0;
    configureLogging({
        sink: (record: LogRecord) => {
            const now = Date.now();
            if (now - windowStart >= 1000) {
                windowStart = now;
                sent = 0;
            }
            if (++sent > perSecond) return;
            scope.postMessage({ kind: "log", record } satisfies RpcResponse);
        },
    });
}
