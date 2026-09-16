// Worker-side RPC dispatch.
//
// Owns error normalisation for every worker entrypoint, and rejects unknown
// methods explicitly rather than dropping the message and hanging the caller.

import { configureLogging, type LogRecord } from "../../log/logger.js";
import { NODE_WORKER_THREADS } from "../detect.js";
import { toWireError } from "./error-wire.js";
import type { MethodMap, RpcControl, RpcRequest, RpcResponse, WorkerScopeLike } from "./types.js";

export type Handlers<M extends MethodMap> = {
    [K in keyof M]: (params: M[K]["params"]) => Promise<M[K]["result"]> | M[K]["result"];
};

interface ServeOptions<M extends MethodMap> {
    /** Defaults to the worker global. */
    scope?: WorkerScopeLike;
    /** Buffers to transfer back with a result. */
    transferablesOf?: (method: keyof M & string, result: unknown) => readonly unknown[];
    /**
     * Forward log records to the client so worker output reaches the app's
     * sink. Browser worker `console` goes to a separate devtools context and
     * Node worker output is interleaved and unattributed.
     */
    forwardLogs?: boolean;
    /** Cap on forwarded records per second; excess is dropped. Default 200. */
    logRateLimit?: number;
}

/**
 * The worker global, or `undefined` where it is not the message port.
 *
 * In a browser worker `globalThis` is the scope. Under `node:worker_threads`
 * it is not: messages arrive on `parentPort`, and `globalThis` carries an
 * `addEventListener` that never receives them.
 */
function globalScope(): WorkerScopeLike | undefined {
    const g = globalThis as unknown as Partial<WorkerScopeLike>;
    return typeof g.postMessage === "function" ? (g as WorkerScopeLike) : undefined;
}

/**
 * `parentPort` behind the same shape as a browser worker scope.
 *
 * Node delivers `message` through an `EventEmitter` whose listener takes the
 * data directly, so it is wrapped into the `{ data }` envelope the handler
 * expects. Messages posted before the listener attaches stay queued on the
 * port, so installing asynchronously loses none.
 */
async function nodeScope(): Promise<WorkerScopeLike | undefined> {
    const { parentPort } = (await import(/* @vite-ignore */ NODE_WORKER_THREADS)) as {
        parentPort: {
            postMessage(msg: unknown, transfer?: readonly unknown[]): void;
            on(type: string, cb: (data: unknown) => void): void;
        } | null;
    };
    if (!parentPort) return undefined;
    return {
        postMessage: (msg, transfer) => parentPort.postMessage(msg, transfer),
        addEventListener: (type, cb) => parentPort.on(type, (data) => cb({ data })),
    };
}

/**
 * Install the message handler. Call once, at worker top level.
 *
 * Resolves synchronously in a browser worker. Under Node the port is reached
 * through a dynamic import, so the handler installs on a later tick.
 */
export function serveWorkerRpc<M extends MethodMap>(
    handlers: Handlers<M>,
    opts: ServeOptions<M> = {},
): void {
    const scope = opts.scope ?? globalScope();
    if (scope) {
        install(scope, handlers, opts);
        return;
    }
    void nodeScope().then((port) => {
        if (port) install(port, handlers, opts);
    });
}

function install<M extends MethodMap>(
    scope: WorkerScopeLike,
    handlers: Handlers<M>,
    opts: ServeOptions<M>,
): void {
    if (opts.forwardLogs) installLogForwarder(scope, opts.logRateLimit ?? 200);

    const onMessage = async (ev: { data: unknown }): Promise<void> => {
        const ctrl = ev?.data as RpcControl | undefined;
        if (ctrl?.kind === "log-config") {
            // Replicate the client's level/filter; the sink is local.
            configureLogging({ level: ctrl.level, namespaces: ctrl.namespaces });
            return;
        }

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
            try {
                post(scope, { id: req.id, ok: true, result }, transfer);
            } catch (err) {
                // As in `postError`: an unclonable result must reach the caller
                // as a failure rather than no response.
                postError(scope, req.id, err);
            }
        } catch (err) {
            postError(scope, req.id, err);
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

/**
 * Answer a failed call, falling back to a minimal payload if the rich one
 * cannot be cloned.
 *
 * `toWireError` carries the error's `context`, and structured clone rejects a
 * function or class instance nested in it. Throwing inside the catch would send
 * no response, leaving the caller pending until its timeout.
 */
function postError(scope: WorkerScopeLike, id: number, err: unknown): void {
    try {
        post(scope, { id, ok: false, error: toWireError(err) });
    } catch {
        post(scope, {
            id,
            ok: false,
            error: {
                name: "WorkerRpcError",
                message: `worker error could not be serialised: ${String(err)}`,
                code: "WORKER_FAILED",
            },
        });
    }
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
