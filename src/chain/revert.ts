// Classifies a failed contract read: the contract's own refusal, or a failure of the read.
//
// A revert (or a call that returned no data) is the contract's own answer, so a probe for an
// optional selector may read it as "unsupported". Anything else (a timeout, a 429, a dropped
// connection, a malformed response) says nothing about the contract, and treating it as "no"
// would cache a wrong answer: an asset read as plain when it yields.
//
// Matched by error name along the `cause` chain, not `instanceof`, so this module needs no viem
// import and still recognises errors from a second viem copy in the bundle.

import { causeChain } from "../errors/base.js";

/**
 * viem errors that carry the contract's answer rather than a transport failure.
 *
 * `ContractFunctionZeroDataError` is a call that succeeded with empty return data: the selector
 * does not exist on the target, which is the same answer a revert gives for a probe.
 */
const REVERT_NAMES = new Set([
    "ContractFunctionRevertedError",
    "ContractFunctionZeroDataError",
    "ExecutionRevertedError",
]);

/** Text an RPC node or a non-viem adapter uses for a reverted call. */
const REVERT_TEXT = /execution reverted|reverted|returned no data \("0x"\)/i;

/** Viem error names for transport failures, which never mean "reverted" whatever they say. */
const TRANSPORT_NAMES = new Set([
    "HttpRequestError",
    "TimeoutError",
    "WebSocketRequestError",
    "RpcRequestError",
    "LimitExceededRpcError",
    "ResourceUnavailableRpcError",
    "InternalRpcError",
]);

/**
 * Whether `err` is the contract itself refusing the call (a revert or empty return data), as
 * opposed to the read failing.
 *
 * Falls back to the message only when the `cause` chain holds no viem-typed error, for adapters
 * that surface a node's `execution reverted` text as a plain `Error`.
 */
export function isContractRevert(err: unknown): boolean {
    let sawTyped = false;
    for (const cur of causeChain(err)) {
        if (!(cur instanceof Error)) break;
        if (REVERT_NAMES.has(cur.name)) return true;
        if (TRANSPORT_NAMES.has(cur.name)) return false;
        if (cur.name !== "Error") sawTyped = true;
    }
    if (sawTyped) return false;
    return err instanceof Error && REVERT_TEXT.test(err.message);
}
