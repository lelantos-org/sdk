// Shared worker RPC: transport types.
//
// One `WorkerLike` for the whole SDK.
//
// Members are declared with METHOD syntax, not property-with-arrow, on
// purpose: method parameters stay bivariant under `strictFunctionTypes`,
// which is what lets one interface accept both a DOM `Worker` (whose
// transfer list is `Transferable[]`) and a `node:worker_threads` Worker
// (`TransferListItem[]`) without falling back to `any`.

/**
 * Minimal worker surface. Satisfied by a DOM `Worker`, a
 * `node:worker_threads` Worker, and any test double.
 *
 * Note that Node's Worker is an `EventEmitter`: it has `on`, but neither
 * `onmessage` nor `onerror`. The client probes for all three.
 */
export interface WorkerLike {
    postMessage(msg: unknown, transfer?: readonly unknown[]): void;
    // Return type is `void` deliberately: a Node worker`s Promise<number>
    // is assignable to it, but a DOM worker`s void is not assignable to a
    // union containing Promise.
    terminate(): void;
    onmessage?: ((ev: { data: unknown }) => void) | null;
    onerror?: ((ev: unknown) => void) | null;
    onmessageerror?: ((ev: unknown) => void) | null;
    addEventListener?(type: string, cb: (ev: any) => void): void;
    on?(event: string, cb: (arg: any) => void): void;
}

/** The worker-side global, as seen from inside a module worker. */
export interface WorkerScopeLike {
    onmessage?: ((ev: { data: unknown }) => void) | null;
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
    stack?: string;
    /** `WalletError.code` when the remote threw a typed SDK error. */
    code?: string;
    context?: Record<string, unknown>;
    cause?: WireError;
}

export type RpcResponse =
    | { id: number; ok: true; result: unknown }
    | { id: number; ok: false; error: WireError }
    /** Out-of-band log record forwarded from the worker. */
    | { kind: "log"; record: unknown };

/** One entry in a {@link MethodMap}. */
export interface MethodSpec {
    params: unknown;
    result: unknown;
}

/**
 * Per-domain method table: maps a method name to its params and result.
 *
 * Declare domain tables as plain types, WITHOUT `extends MethodMap` — the
 * generic constraint checks them either way, and inheriting the index
 * signature would widen every handler's parameter to `unknown`:
 *
 * ```ts
 * type ScannerMethods = {
 *     init: { params: { wasm?: WireWasmConfig }; result: void };
 *     scan: { params: ScanParams; result: ScanResult };
 * };
 * ```
 */
export type MethodMap = Record<string, MethodSpec>;
