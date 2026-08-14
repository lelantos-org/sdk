// Shared worker RPC: transport types.
//
// One `WorkerLike` for the whole SDK.
//
// Members use method syntax rather than property-with-arrow: method
// parameters stay bivariant under `strictFunctionTypes`, which lets one
// interface accept both a DOM `Worker` (transfer list `Transferable[]`) and a
// `node:worker_threads` Worker (`TransferListItem[]`) without an `any`.

import type { LogLevel } from "../log/logger.js";

/**
 * Minimal worker surface. Satisfied by a DOM `Worker`, a
 * `node:worker_threads` Worker, and any test double.
 *
 * Node's Worker is an `EventEmitter`: it has `on`, but neither
 * `onmessage` nor `onerror`. The client probes for all three.
 */
export interface WorkerLike {
    postMessage(msg: unknown, transfer?: readonly unknown[]): void;
    // Return type is `void` deliberately: a Node worker`s Promise<number>
    // is assignable to it, but a DOM worker`s void is not assignable to a
    // union containing Promise.
    terminate(): void;
    onmessage?: (((ev: { data: unknown }) => void) | null) | undefined;
    onerror?: (((ev: unknown) => void) | null) | undefined;
    onmessageerror?: (((ev: unknown) => void) | null) | undefined;
    addEventListener?(type: string, cb: (ev: any) => void): void;
    on?(event: string, cb: (arg: any) => void): void;
}

/** The worker-side global, as seen from inside a module worker. */
export interface WorkerScopeLike {
    onmessage?: (((ev: { data: unknown }) => void) | null) | undefined;
    postMessage(msg: unknown, transfer?: readonly unknown[]): void;
    addEventListener?(type: string, cb: (ev: any) => void): void;
}

/** Envelope for a call. `id` correlates the response. */
export interface RpcRequest {
    id: number;
    method: string;
    params: unknown;
}

/** Serialised remote error. One `cause` level is preserved, depth-capped. */
export interface WireError {
    name: string;
    message: string;
    stack?: string | undefined;
    /** `WalletError.code` when the remote threw a typed SDK error. */
    code?: string | undefined;
    context?: Record<string, unknown> | undefined;
    cause?: WireError | undefined;
}

export type RpcResponse =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; error: WireError }
    /** Out-of-band log record forwarded from the worker. */
    | { kind: "log"; record: unknown };

/**
 * Client → worker control messages, distinguished from an {@link RpcRequest}
 * by carrying `kind` instead of `id`.
 *
 * `log-config` replicates the client's logging level and namespace filter into
 * the worker realm. Logging state is module-local and a worker is a separate
 * realm, so without this the worker sits at `silent` and every `timed()` call
 * short-circuits — the sink installed by `forwardLogs` never receives anything
 * to forward.
 */
export type RpcControl = {
    kind: "log-config";
    level: LogLevel;
    namespaces: string[] | null;
};

/** One entry in a {@link MethodMap}. */
export interface MethodSpec {
    params: unknown;
    result: unknown;
}

/**
 * Per-domain method table: maps a method name to its params and result.
 *
 * Declare domain tables as plain types, without `extends MethodMap`: the
 * generic constraint checks them either way, and inheriting the index
 * signature would widen every handler's parameter to `unknown`.
 *
 * ```ts
 * type ScannerMethods = {
 *     init: { params: { wasm?: WireWasmConfig }; result: void };
 *     scan: { params: ScanParams; result: ScanResult };
 * };
 * ```
 */
export type MethodMap = Record<string, MethodSpec>;
