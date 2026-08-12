// Error serialisation across the worker boundary.
//
// Structured clone can carry `Error` natively, but it loses subclass
// identity, varies across runtimes, and is unreliable for `cause` chains — so
// errors are encoded explicitly. The wire form carries the worker-side stack,
// so the rethrown error points at the failure rather than at the transport.

import { isWalletError, WorkerRpcError } from "../core/errors.js";
import type { WireError } from "./types.js";

const MAX_CAUSE_DEPTH = 3;

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
        const ctx = (err as { context?: Record<string, unknown> | undefined }).context;
        if (ctx && Object.keys(ctx).length > 0) out.context = jsonSafe(ctx);
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
        context?: Record<string, unknown> | undefined;
        site?: Error | undefined;
    },
): WorkerRpcError {
    const err = new WorkerRpcError(code, message, {
        method: opts.method,
        cause: opts.cause,
        context: opts.context,
    });
    if (opts.site?.stack) {
        // Keep the call-site frames, re-headed with this error's identity.
        const frames = opts.site.stack.split("\n").slice(1).join("\n");
        err.stack = `${err.name}: ${err.message}\n${frames}`;
    }
    return err;
}

function jsonSafe(o: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
        out[k] = typeof v === "bigint" ? v.toString() : v;
    }
    return out;
}

function safeStringify(v: unknown): string {
    try {
        return JSON.stringify(v) ?? String(v);
    } catch {
        return String(v);
    }
}
