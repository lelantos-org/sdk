// Error serialisation across the worker boundary.
//
// Structured clone can carry `Error` natively, but it loses subclass identity,
// varies across runtimes and is unreliable for `cause` chains, so errors are
// encoded explicitly. The wire form carries the worker-side stack, so the
// rethrown error points at the failure rather than the transport.

import { isWalletError } from "../../errors/guard.js";
import { WorkerRpcError } from "../../errors/worker.js";
import type { WireError } from "./types.js";

const MAX_CAUSE_DEPTH = 3;

/** Carried by `WireError` in their own right, so not repeated in `fields`. */
const WIRE_OWN_KEYS: ReadonlySet<string> = new Set([
    "name",
    "message",
    "stack",
    "code",
    "context",
    "cause",
]);

/** Encode anything thrown for transport. Never throws. */
export function toWireError(err: unknown, depth = 0): WireError {
    if (!(err instanceof Error)) {
        return { name: "NonError", message: typeof err === "string" ? err : safeStringify(err) };
    }
    const out: WireError = {
        name: err.name,
        message: err.message,
        stack: err.stack,
    };
    if (isWalletError(err)) {
        out.code = err.code;
        const context = err.context && cloneSafe(err.context);
        if (context) out.context = context;
        // Own enumerable fields beyond the `Error` shape, such as
        // `InsufficientCoverError.consolidate`. `isWalletError(e, code)` is
        // duck-typed on `code`, so without these the narrowed type's extra
        // fields would read back `undefined`.
        const fields = cloneSafe(err, WIRE_OWN_KEYS);
        if (fields) out.fields = fields;
    }
    if (err.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
        out.cause = toWireError(err.cause, depth + 1);
    }
    return out;
}

/** Rebuild a transported error, preserving the remote name, stack and code. */
export function fromWireError(w: WireError): Error {
    const e = new Error(w.message);
    e.name = w.name;
    if (w.stack) e.stack = w.stack;
    if (w.code) (e as { code?: string | undefined }).code = w.code;
    if (w.context) (e as { context?: unknown | undefined }).context = w.context;
    if (w.fields) Object.assign(e, w.fields);
    if (w.cause) (e as { cause?: unknown | undefined }).cause = fromWireError(w.cause);
    return e;
}

/**
 * Wrap a remote failure in a local error whose own stack is the CALL SITE,
 * with the reconstructed remote error (carrying the worker's stack) as
 * `cause`. Both halves of the trace stay visible.
 */
export function rpcError(
    code: "WORKER_TIMEOUT" | "WORKER_CRASHED" | "WORKER_FAILED",
    message: string,
    opts: {
        method?: string | undefined;
        cause?: unknown | undefined;
        details?: Readonly<Record<string, string | number | boolean>> | undefined;
        site?: Error | undefined;
    },
): WorkerRpcError {
    const err = new WorkerRpcError(code, message, {
        method: opts.method,
        cause: opts.cause,
        details: opts.details,
    });
    if (opts.site?.stack) {
        // Keep the call-site frames, re-headed with this error's identity.
        const frames = opts.site.stack.split("\n").slice(1).join("\n");
        err.stack = `${err.name}: ${err.message}\n${frames}`;
    }
    return err;
}

/**
 * `o`'s own enumerable properties outside `skip`, as data safe to clone: a bigint as its decimal
 * string, a function or symbol dropped. `undefined` when none remain.
 */
function cloneSafe(o: object, skip?: ReadonlySet<string>): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {};
    let any = false;
    for (const [k, v] of Object.entries(o)) {
        if (skip?.has(k)) continue;
        // Structured clone carries plain data; a function or symbol would make
        // `postMessage` throw and lose the whole reply.
        if (typeof v === "function" || typeof v === "symbol") continue;
        out[k] = typeof v === "bigint" ? v.toString() : v;
        any = true;
    }
    return any ? out : undefined;
}

function safeStringify(v: unknown): string {
    try {
        return JSON.stringify(v) ?? String(v);
    } catch {
        return String(v);
    }
}
