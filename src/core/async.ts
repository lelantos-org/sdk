// Async primitives shared across HTTP, worker RPC, and wasm init.
//
// Every timeout in the SDK goes through `withTimeout`, which clears its timer
// on both outcomes. A bare `Promise.race` leaks the pending timer and keeps
// the Node event loop alive until it fires.

import { safeCall } from "./callbacks.js";

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
        // A non-Error reason is wrapped: `AbortSignal.reason` is whatever was
        // passed to `abort()` and is commonly a plain string, which would
        // defeat every downstream `instanceof` and `isWalletError` check.
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
    // Clamped to the documented range. A jitter above 1 makes `delayMs`
    // negative, and a negative `retries` skipped the loop entirely and threw
    // `undefined` — a non-Error that defeats every `instanceof` and
    // `isWalletError` check downstream.
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
            // Guarded: the hook is documented "must not throw", and a hook
            // that did replaced the real network error with its own.
            safeCall("onRetry", policy.onRetry, { attempt, delayMs, err });
            if ((await sleep(delayMs, policy.signal)) === "aborted") throw err;
        }
    }
    // Unreachable while `retries >= 0`, since the loop always returns or
    // throws. Kept as a typed backstop rather than a thrown `undefined`.
    throw lastErr instanceof Error ? lastErr : new Error("retry: no attempt was made");
}

/** An `Error` as-is; anything else wrapped so a rejection is always one. */
function asError(reason: unknown): Error | undefined {
    if (reason === undefined) return undefined;
    if (reason instanceof Error) return reason;
    return new Error(typeof reason === "string" ? reason : String(reason));
}

// --- serialisation -----------------------------------------------------------

/** Runs operations one at a time, in the order they were handed over. */
export interface Mutex {
    /**
     * Run `op` after everything already queued, and before anything queued
     * later. Resolves or rejects with `op`'s own outcome.
     */
    run<T>(op: () => Promise<T>): Promise<T>;
}

/**
 * A promise-chain mutex.
 *
 * The SDK's recurring hazard is check-then-act across an `await` on shared
 * state: read a balance then decide to top up, read a snapshot then persist
 * it, read a cursor then advance it. Two overlapping callers interleave and
 * the later write wins. This is the uniform fix.
 *
 * A failed operation settles the chain without poisoning it — the next caller
 * runs regardless, and the error still reaches whoever queued the failure.
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
export interface KeyedMutex<K> {
    run<T>(key: K, op: () => Promise<T>): Promise<T>;
}

/**
 * Independent mutexes keyed by `K`.
 *
 * For state that is partitioned rather than global — one ephemeral payer per
 * host, say — so unrelated keys still proceed in parallel.
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

// --- cancellation ------------------------------------------------------------

/** A controller chained to a parent signal. See {@link linkAbort}. */
export interface LinkedAbort {
    /** Aborts when this controller aborts, or when the parent does. */
    readonly signal: AbortSignal;
    /** Abort locally — a timeout, or work being abandoned. Idempotent. */
    abort(reason?: unknown): void;
    /** Detach from the parent. Call on every exit path. */
    dispose(): void;
}

/**
 * An `AbortController` that also aborts when `parent` does.
 *
 * Not `AbortSignal.any`, because the parent here routinely outlives the work:
 * a wallet-lifetime signal handed to hundreds of chunk fetches accumulates a
 * listener per call, which Node warns about past ten. `dispose` makes the
 * detach explicit and reviewable.
 *
 * A parent that has *already* aborted is honoured immediately — adding a
 * listener to it would never fire, which is the bug this helper exists to stop
 * people rewriting.
 */
export function linkAbort(parent?: AbortSignal | undefined): LinkedAbort {
    const ctrl = new AbortController();
    if (parent?.aborted) ctrl.abort(parent.reason);

    const onParentAbort = () => ctrl.abort(parent?.reason);
    parent?.addEventListener("abort", onParentAbort, { once: true });

    return {
        signal: ctrl.signal,
        abort: (reason?: unknown) => ctrl.abort(reason),
        dispose: () => parent?.removeEventListener("abort", onParentAbort),
    };
}

// --- memoisation -------------------------------------------------------------

/** A lazily-built value, rebuilt on demand. See {@link memoAsync}. */
export interface AsyncMemo<T> {
    /** Build on first call; every later call joins the same promise. */
    get(): Promise<T>;
    /** The built value, if it is ready. Never triggers a build. */
    peek(): T | undefined;
    /**
     * The in-flight or completed build, if one has started. Never starts one.
     *
     * For teardown that must not build in order to tear down, but must still
     * wait for a build already under way rather than leaking it.
     */
    inFlight(): Promise<T> | undefined;
    /** Discard what was built, so the next `get()` builds again. */
    reset(): void;
}

/**
 * Memoise an async build, evicting on rejection.
 *
 * The eviction is the point. A plain `promise ??= build()` caches the
 * *rejection* too, so one transient failure — an `EMFILE` reading a wasm file,
 * a 502 fetching it, an RPC blip — is replayed to every later caller in the
 * realm, permanently, with no way to recover. That pattern appeared five times
 * in this codebase before this helper existed, and the two places that got it
 * right did so by hand.
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

function noop(): void {}
