// Async primitives shared across HTTP, worker RPC, and wasm init.
//
// Every timeout in the SDK goes through `withTimeout`, which clears its timer
// on both outcomes. A bare `Promise.race` leaks the pending timer and keeps
// the Node event loop alive until it fires.

/** Outcome of an interruptible sleep. */
export type SleepOutcome = "ok" | "aborted";

/**
 * Sleep, distinguishing a completed wait from an aborted one. Callers that
 * cannot tell the two apart end up reporting a timeout when the user
 * cancelled.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<SleepOutcome> {
    if (signal?.aborted) return Promise.resolve("aborted");
    return new Promise((resolve) => {
        const onAbort = () => {
            clearTimeout(timer);
            resolve("aborted");
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve("ok");
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

/**
 * Reject with `mkError()` if `p` has not settled within `ms`. The timer is
 * always cleared, so a fast success leaves nothing pending.
 */
export function withTimeout<T>(
    p: Promise<T>,
    ms: number,
    mkError: () => Error,
    signal?: AbortSignal,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            fn();
        };
        const onAbort = () => finish(() => reject(signal?.reason ?? mkError()));
        const timer = setTimeout(() => finish(() => reject(mkError())), ms);
        signal?.addEventListener("abort", onAbort, { once: true });
        p.then(
            (v) => finish(() => resolve(v)),
            (e) => finish(() => reject(e)),
        );
    });
}

export interface RetryPolicy {
    /** Additional attempts after the first. `0` disables retrying. */
    retries: number;
    /** Base backoff, doubled per attempt. */
    backoffMs: number;
    /** Fraction of the delay to randomise, in `[0, 1]`. Default 0.25. */
    jitter?: number;
    /** Return false to stop retrying and rethrow immediately. */
    shouldRetry?: (err: unknown, attempt: number) => boolean;
    /** Observability hook; must not throw. */
    onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
    signal?: AbortSignal;
}

/** Exponential backoff with jitter. `fn` receives the 0-based attempt number. */
export async function retry<T>(
    fn: (attempt: number) => Promise<T>,
    policy: RetryPolicy,
    rand: () => number = Math.random,
): Promise<T> {
    const jitter = policy.jitter ?? 0.25;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= policy.retries; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastErr = err;
            const more = attempt < policy.retries;
            if (!more || policy.shouldRetry?.(err, attempt) === false) throw err;
            const base = policy.backoffMs * 2 ** attempt;
            const delayMs = Math.round(base * (1 - jitter + rand() * jitter * 2));
            policy.onRetry?.({ attempt, delayMs, err });
            if ((await sleep(delayMs, policy.signal)) === "aborted") throw err;
        }
    }
    throw lastErr;
}
