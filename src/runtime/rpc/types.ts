// Shared worker RPC: transport types.
//
// One `WorkerLike` for the whole SDK.
//
// Members use method syntax rather than property-with-arrow: method
// parameters stay bivariant under `strictFunctionTypes`, which lets one
// interface accept both a DOM `Worker` (transfer list `Transferable[]`) and a
// `node:worker_threads` Worker (`TransferListItem[]`) without an `any`.
//
// The handler slots are nullable properties, not methods, so they take
// `(ev: any)`. A narrower parameter is contravariant and a DOM `Worker` would
// no longer satisfy the interface: `onmessage: ((ev: MessageEvent) => any) |
// null` is not assignable to `((ev: { data: unknown }) => void) | null`,
// because `{ data: unknown }` is not assignable to `MessageEvent`.
// `types.test.ts` checks both directions.

import type { LogLevel } from "../../log/logger.js";

/**
 * Minimal worker surface. Satisfied by a DOM `Worker`, a
 * `node:worker_threads` Worker, and any test double.
 *
 * Node's Worker is an `EventEmitter`: it has `on`, but neither
 * `onmessage` nor `onerror`. The client probes for all three.
 */
export interface WorkerLike {
    postMessage(msg: unknown, transfer?: readonly unknown[]): void;
    // Return type is `void`: a Node worker's `Promise<number>` is assignable to
    // it, but a DOM worker's `void` is not assignable to a union containing
    // `Promise`.
    terminate(): void;
    onmessage?: (((ev: any) => void) | null) | undefined;
    onerror?: (((ev: any) => void) | null) | undefined;
    onmessageerror?: (((ev: any) => void) | null) | undefined;
    addEventListener?(type: string, cb: (ev: any) => void): void;
    on?(event: string, cb: (arg: any) => void): void;
}

/**
 * Spawns a worker. Callers write the `new Worker(...)` expression at their own
 * call site: bundlers emit a worker chunk only for that literal form and cannot
 * see a URL passed through a helper (Vite inlines a small worker entry as a
 * `data:` URL under `build.assetsInlineLimit`, whose relative imports then fail
 * at runtime). A factory also supports other bundler forms
 * (`import W from "…?worker"`, then `() => new W()`) and lets
 * `WorkerPoolScanner` respawn a dead worker.
 *
 * ```ts
 * () => new Worker(new URL("@lelantos-org/sdk/workers/scanner", import.meta.url), {
 *     type: "module",
 * })
 * ```
 */
export type WorkerFactory = () => WorkerLike;

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
    /**
     * Typed fields a `WalletError` subclass adds beyond the `Error` shape, such
     * as `InsufficientCoverError.consolidate`. Carried so the type narrowed by
     * `isWalletError(e, code)` holds for a worker-origin error.
     */
    fields?: Record<string, unknown> | undefined;
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
 * the worker realm. Logging state is module-local, so without this the worker
 * stays at `silent`, every `timed()` call short-circuits, and the sink
 * installed by `forwardLogs` receives nothing.
 */
export type RpcControl = {
    kind: "log-config";
    level: LogLevel;
    namespaces: string[] | null;
};

/** One entry in a {@link MethodMap}. */
interface MethodSpec {
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
