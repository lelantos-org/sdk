// Guarded invocation of caller-supplied callbacks.

import { getLogger } from "../log/logger.js";

const log = getLogger("lelantos:callback");

/**
 * Invoke a caller-supplied callback, logging and swallowing any throw, so a
 * throwing listener cannot break an in-flight operation. Use for every
 * user-provided hook that fires mid-operation.
 */
export function safeCall<A>(name: string, cb: ((arg: A) => void) | undefined, arg: A): void {
    if (!cb) return;
    try {
        cb(arg);
    } catch (err) {
        log.warn("callback threw; ignored", { callback: name, err });
    }
}
