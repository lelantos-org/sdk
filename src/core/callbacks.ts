// Guarded invocation of caller-supplied callbacks.
//
// A throwing listener must never break an in-flight transaction, so throws are
// swallowed — and logged, so they stay diagnosable.

import { getLogger } from "../log/logger.js";

const log = getLogger("lelantos:callback");

/**
 * Invoke a caller-supplied callback, swallowing (and logging) any throw.
 * Use for every user-provided hook that fires mid-operation.
 */
export function safeCall<A>(name: string, cb: ((arg: A) => void) | undefined, arg: A): void {
    if (!cb) return;
    try {
        cb(arg);
    } catch (err) {
        log.warn("callback threw; ignored", { callback: name, err });
    }
}

/** Phase-progress callback. Swallows listener errors — see {@link safeCall}. */
export function safePhase<P>(cb: ((p: P) => void) | undefined, phase: P): void {
    safeCall("onPhase", cb, phase);
}
