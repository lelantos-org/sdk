// Async primitives shared across HTTP, worker RPC and wasm init.

import { safeCall } from "./callbacks.js";

/** Outcome of an interruptible sleep. */
export type SleepOutcome = "ok" | "aborted";

/**
 * Sleep, distinguishing a completed wait from an aborted one so callers do not
 * report a timeout when the user cancelled.
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
 * Let the event loop run pending tasks (rendering, input, timers, I/O callbacks) before
 * continuing. An `await` of a settled promise does not: it runs microtasks only.
 */
export function yieldToEventLoop(): Promise<void> {
    // `scheduler.yield` resumes ahead of other queued tasks and is not clamped like a nested
    // `setTimeout`. Absent from Node and some browsers.
    const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof scheduler?.yield === "function") return scheduler.yield();
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A checkpoint for long synchronous work done in steps. Awaiting the returned function yields to
 * the event loop once `budgetMs` has passed since the last yield, and is otherwise immediate.
 */
export function yieldEvery(
    budgetMs: number,
    now: () => number = () => performance.now(),
): () => Promise<void> {
    let sliceStart = now();
    return async () => {
        if (now() - sliceStart < budgetMs) return;
        await yieldToEventLoop();
        sliceStart = now();
    };
}

/**
 * Reject with `mkError()` if `p` has not settled within `ms`. The timer is
 * cleared on every outcome; a bare `Promise.race` leaves it pending and keeps
 * the Node event loop alive until it fires.
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
        // `AbortSignal.reason` is whatever was passed to `abort()`, often a
        // string, so a non-Error reason is wrapped.
        const onAbort = () => finish(() => reject(asError(signal?.reason) ?? mkError()));
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
    jitter?: number | undefined;
    /** Return false to stop retrying and rethrow immediately. */
    shouldRetry?: ((err: unknown, attempt: number) => boolean) | undefined;
    /** Observability hook; must not throw. */
    onRetry?: ((info: { attempt: number; delayMs: number; err: unknown }) => void) | undefined;
    signal?: AbortSignal | undefined;
}

/** Exponential backoff with jitter. `fn` receives the 0-based attempt number. */
export async function retry<T>(
    fn: (attempt: number) => Promise<T>,
    policy: RetryPolicy,
    rand: () => number = Math.random,
): Promise<T> {
    // Clamped to the documented range: a jitter above 1 makes `delayMs`
    // negative, and a negative `retries` would skip the loop without calling
    // `fn`.
    const jitter = Math.min(1, Math.max(0, policy.jitter ?? 0.25));
    const retries = Math.max(0, policy.retries);

    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            lastErr = err;
            const more = attempt < retries;
            if (!more || policy.shouldRetry?.(err, attempt) === false) throw err;
            const base = policy.backoffMs * 2 ** attempt;
            const delayMs = Math.round(base * (1 - jitter + rand() * jitter * 2));
            // Guarded so a throwing hook cannot replace the real error.
            safeCall("onRetry", policy.onRetry, { attempt, delayMs, err });
            // Rejects with the caller's abort reason, as `fetch` does, not with
            // the failure being backed off from.
            if ((await sleep(delayMs, policy.signal)) === "aborted") throw policy.signal?.reason;
        }
    }
    // Unreachable: with `retries >= 0` the loop always returns or throws.
    throw lastErr instanceof Error ? lastErr : new Error("retry: no attempt was made");
}

/** An `Error` as-is; anything else wrapped so a rejection is always one. */
function asError(reason: unknown): Error | undefined {
    if (reason === undefined) return undefined;
    if (reason instanceof Error) return reason;
    return new Error(typeof reason === "string" ? reason : String(reason));
}

/**
 * Settle every task, reporting each rejection to `onError`, so one failure
 * does not leave the others unsettled.
 */
export async function settleAll(
    tasks: readonly unknown[],
    onError: (err: unknown) => void,
): Promise<void> {
    for (const outcome of await Promise.allSettled(tasks)) {
        if (outcome.status === "rejected") onError(outcome.reason);
    }
}

/** Runs operations one at a time, in the order they were handed over. */
export interface Mutex {
    /**
     * Run `op` after everything already queued, and before anything queued
     * later. Resolves or rejects with `op`'s own outcome.
     */
    run<T>(op: () => Promise<T>): Promise<T>;
}

/**
 * A promise-chain mutex, for check-then-act across an `await` on shared state,
 * where overlapping callers would interleave and the later write would win.
 *
 * A failed operation does not poison the chain: the next caller runs
 * regardless, and the error reaches whoever queued the failure.
 */
export function createMutex(): Mutex {
    let tail: Promise<unknown> = Promise.resolve();
    return {
        run<T>(op: () => Promise<T>): Promise<T> {
            const run = tail.then(op, op);
            tail = run.then(noop, noop);
            return run;
        },
    };
}

/** One independent {@link Mutex} per key, created on first use. */
interface KeyedMutex<K> {
    run<T>(key: K, op: () => Promise<T>): Promise<T>;
}

/**
 * Independent mutexes keyed by `K`, for partitioned state: unrelated keys
 * proceed in parallel.
 */
export function createKeyedMutex<K>(): KeyedMutex<K> {
    const byKey = new Map<K, Mutex>();
    return {
        run<T>(key: K, op: () => Promise<T>): Promise<T> {
            let mutex = byKey.get(key);
            if (!mutex) {
                mutex = createMutex();
                byKey.set(key, mutex);
            }
            return mutex.run(op);
        },
    };
}

/** A controller chained to a parent signal. See {@link linkAbort}. */
export interface LinkedAbort {
    /** Aborts when this controller aborts, or when the parent does. */
    readonly signal: AbortSignal;
    /** Abort locally (a timeout, or abandoned work). Idempotent. */
    abort(reason?: unknown): void;
    /** Detach from the parent. Call on every exit path. */
    dispose(): void;
    /**
     * Scope-exit release: detaches and aborts, since leaving the scope ends the
     * work. {@link LinkedAbort.dispose} only detaches and leaves the controller
     * live.
     */
    [Symbol.dispose](): void;
}

/**
 * An `AbortController` that also aborts when `parent` does.
 *
 * Not `AbortSignal.any`: a parent that outlives the work would accumulate a
 * listener per call, so the detach is explicit (`dispose`).
 *
 * An already-aborted parent is honoured immediately, since a listener added to
 * it never fires.
 */
export function linkAbort(parent?: AbortSignal | undefined): LinkedAbort {
    const ctrl = new AbortController();
    if (parent?.aborted) ctrl.abort(parent.reason);

    const onParentAbort = () => ctrl.abort(parent?.reason);
    parent?.addEventListener("abort", onParentAbort, { once: true });

    const detach = () => parent?.removeEventListener("abort", onParentAbort);

    return {
        signal: ctrl.signal,
        abort: (reason?: unknown) => ctrl.abort(reason),
        dispose: detach,
        [Symbol.dispose]: () => {
            detach();
            ctrl.abort();
        },
    };
}

/** A lazily-built value, rebuilt on demand. See {@link memoAsync}. */
export interface AsyncMemo<T> {
    /** Build on first call; every later call joins the same promise. */
    get(): Promise<T>;
    /** The built value, if it is ready. Never triggers a build. */
    peek(): T | undefined;
    /**
     * The in-flight or completed build, if one has started. Never starts one,
     * so teardown can await a build already under way without triggering one.
     */
    inFlight(): Promise<T> | undefined;
    /** Discard what was built, so the next `get()` builds again. */
    reset(): void;
}

/**
 * Memoise an async build, evicting on rejection. A plain `promise ??= build()`
 * caches the rejection and replays one transient failure to every later caller.
 */
export function memoAsync<T>(build: () => Promise<T>): AsyncMemo<T> {
    let pending: Promise<T> | undefined;
    let value: T | undefined;

    return {
        get(): Promise<T> {
            pending ??= build().then(
                (v) => {
                    value = v;
                    return v;
                },
                (err: unknown) => {
                    pending = undefined;
                    throw err;
                },
            );
            return pending;
        },
        peek: () => value,
        inFlight: () => pending,
        reset(): void {
            pending = undefined;
            value = undefined;
        },
    };
}

/** One lazily-built value per key. See {@link memoAsyncByKey}. */
interface KeyedAsyncMemo<K, T> {
    /** `key`'s value: on first call builds it with `build`; later calls join the same promise. */
    get(key: K, build: () => Promise<T>): Promise<T>;
    /** Forget `key`, so its next `get` builds again. */
    delete(key: K): void;
    /** Forget every key. */
    clear(): void;
}

/** {@link memoAsync} per key: a failed build is evicted, so the next `get` for that key retries. */
export function memoAsyncByKey<K, T>(): KeyedAsyncMemo<K, T> {
    const cache = new Map<K, Promise<T>>();
    return {
        get(key, build) {
            let pending = cache.get(key);
            if (!pending) {
                pending = build().catch((err: unknown) => {
                    cache.delete(key);
                    throw err;
                });
                cache.set(key, pending);
            }
            return pending;
        },
        delete: (key) => {
            cache.delete(key);
        },
        clear: () => cache.clear(),
    };
}

/**
 * {@link memoAsync} whose value expires `ttlMs` after it was built. Concurrent
 * callers share one in-flight build; a failed build is not cached. `now` is
 * injectable for tests.
 */
export function ttlCache<T>(
    build: () => Promise<T>,
    ttlMs: number,
    now: () => number = Date.now,
): () => Promise<T> {
    // Not `memo.peek()`: a built value may itself be `undefined`.
    let builtAt: number | undefined;
    const memo = memoAsync(async () => {
        const v = await build();
        builtAt = now();
        return v;
    });
    return () => {
        if (builtAt !== undefined && now() - builtAt >= ttlMs) {
            builtAt = undefined;
            memo.reset();
        }
        return memo.get();
    };
}

function noop(): void {}
