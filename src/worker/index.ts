// Tier 0 — worker RPC transport, shared by the prover and the scanner pool.
//
// Internal: not published as a package subpath. Each domain keeps its own
// message-type module and declares a `MethodMap`; only the transport is
// shared.

export {
    type CallOptions,
    createWorkerRpc,
    type WorkerRpc,
    type WorkerRpcOptions,
} from "./client.js";
export { fromWireError, rpcError, toWireError } from "./error-wire.js";
export { type Handlers, type ServeOptions, serveWorkerRpc } from "./serve.js";
export { spawnModuleWorker } from "./spawn.js";
export type {
    MethodMap,
    MethodSpec,
    RpcRequest,
    RpcResponse,
    WireError,
    WorkerLike,
    WorkerScopeLike,
} from "./types.js";
