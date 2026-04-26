// The one perf-timing helper for the SDK.
//
// Emits `{ ms }` as a numeric field; presentation is the sink's job.

import type { Logger } from "./logger.js";

/** Time an async span, emitting one debug record when logging is on. */
export async function timed<T>(log: Logger, label: string, fn: () => Promise<T> | T): Promise<T> {
    if (!log.enabled("debug")) return fn();
    const t0 = performance.now();
    try {
        return await fn();
    } finally {
        log.debug(label, { ms: Math.round((performance.now() - t0) * 100) / 100 });
    }
}

/** Time a synchronous span. */
export function timedSync<T>(log: Logger, label: string, fn: () => T): T {
    if (!log.enabled("debug")) return fn();
    const t0 = performance.now();
    try {
        return fn();
    } finally {
        log.debug(label, { ms: Math.round((performance.now() - t0) * 100) / 100 });
    }
}
