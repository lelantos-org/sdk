import { describe, expect, it, vi } from "vitest";
import {
    createKeyedMutex,
    createMutex,
    linkAbort,
    memoAsync,
    retry,
    withTimeout,
} from "./async.js";

// `retry` is the backoff behind every HTTP call in the SDK, and had no tests.

describe("retry", () => {
    const policy = { retries: 2, backoffMs: 0, jitter: 0 };

    it("returns the first success without retrying", async () => {
        const fn = vi.fn(async () => "ok");
        expect(await retry(fn, policy)).toBe("ok");
        expect(fn).toHaveBeenCalledOnce();
    });

    it("retries up to the cap, then rethrows the last error", async () => {
        const fn = vi.fn(async () => {
            throw new Error("nope");
        });
        await expect(retry(fn, policy)).rejects.toThrow("nope");
        expect(fn).toHaveBeenCalledTimes(3);
    });

    it("throws a real Error rather than undefined on a negative cap", async () => {
        // `retries: -1` skipped the loop and threw `lastErr === undefined` — a
        // non-Error that defeats every downstream `instanceof` and
        // `isWalletError` check.
        const fn = vi.fn(async () => "ok");
        await expect(retry(fn, { ...policy, retries: -1 })).resolves.toBe("ok");
        expect(fn).toHaveBeenCalledOnce();
    });

    it("does not let a throwing onRetry replace the real error", async () => {
        // Documented "must not throw", but nothing enforced it — and a hook
        // that did swallowed the network error it was reporting on.
        const fn = vi.fn(async () => {
            throw new Error("network down");
        });
        const onRetry = vi.fn(() => {
            throw new Error("listener blew up");
        });

        await expect(retry(fn, { ...policy, onRetry })).rejects.toThrow("network down");
        expect(onRetry).toHaveBeenCalled();
    });

    it("clamps jitter so the delay cannot go negative", async () => {
        const delays: number[] = [];
        const fn = vi.fn(async (attempt: number) => {
            if (attempt < 2) throw new Error("again");
            return "ok";
        });

        await retry(
            fn,
            {
                retries: 2,
                backoffMs: 100,
                jitter: 5, // out of the documented [0, 1]
                onRetry: ({ delayMs }) => delays.push(delayMs),
            },
            () => 0, // worst case for a jitter above 1
        );

        expect(delays.every((d) => d >= 0)).toBe(true);
    });
});

describe("withTimeout", () => {
    it("rejects with an Error when the abort reason is a bare string", async () => {
        // `AbortSignal.reason` is whatever was passed to `abort()`, commonly a
        // string — which would defeat every `instanceof` check downstream.
        const ctrl = new AbortController();
        const pending = withTimeout(
            new Promise<never>(() => {}),
            1000,
            () => new Error("timeout"),
            ctrl.signal,
        );
        ctrl.abort("user navigated away");

        await expect(pending).rejects.toBeInstanceOf(Error);
        await expect(pending).rejects.toThrow("user navigated away");
    });

    it("passes an Error reason through unchanged", async () => {
        const reason = new Error("cancelled");
        const ctrl = new AbortController();
        const pending = withTimeout(
            new Promise<never>(() => {}),
            1000,
            () => new Error("timeout"),
            ctrl.signal,
        );
        ctrl.abort(reason);

        await expect(pending).rejects.toBe(reason);
    });

    it("resolves a fast success and clears its timer", async () => {
        await expect(withTimeout(Promise.resolve(7), 1000, () => new Error("t"))).resolves.toBe(7);
    });
});

describe("createMutex", () => {
    it("runs operations one at a time, in order", async () => {
        const mutex = createMutex();
        const events: string[] = [];
        const op = (name: string, ms: number) => async () => {
            events.push(`${name}:start`);
            await new Promise((r) => setTimeout(r, ms));
            events.push(`${name}:end`);
        };

        // `a` is slower, so without the mutex `b` would start first.
        await Promise.all([mutex.run(op("a", 10)), mutex.run(op("b", 0))]);

        expect(events).toEqual(["a:start", "a:end", "b:start", "b:end"]);
    });

    it("returns each operation's own result", async () => {
        const mutex = createMutex();
        await expect(mutex.run(async () => 7)).resolves.toBe(7);
    });

    it("does not let a failure poison the chain", async () => {
        const mutex = createMutex();

        await expect(
            mutex.run(async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        // The next caller must still run, and see its own outcome.
        await expect(mutex.run(async () => "ok")).resolves.toBe("ok");
    });
});

describe("createKeyedMutex", () => {
    it("serialises within a key and parallelises across keys", async () => {
        const mutex = createKeyedMutex<string>();
        let inFlight = 0;
        let peakSameKey = 0;
        let peakOverall = 0;

        const op = (track: boolean) => async () => {
            inFlight++;
            peakOverall = Math.max(peakOverall, inFlight);
            if (track) peakSameKey = Math.max(peakSameKey, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
        };

        await Promise.all([
            mutex.run("a", op(false)),
            mutex.run("a", op(false)),
            mutex.run("b", op(false)),
        ]);
        expect(peakOverall).toBe(2); // the two keys overlap; the two "a"s do not

        inFlight = 0;
        await Promise.all([mutex.run("a", op(true)), mutex.run("a", op(true))]);
        expect(peakSameKey).toBe(1);
    });
});

describe("memoAsync", () => {
    it("builds once and shares the promise", async () => {
        const build = vi.fn(async () => "built");
        const memo = memoAsync(build);

        await Promise.all([memo.get(), memo.get()]);
        await memo.get();

        expect(build).toHaveBeenCalledOnce();
    });

    it("does not cache a rejection", async () => {
        // The whole point: a plain `promise ??= build()` replays one transient
        // failure to every later caller in the realm, permanently.
        let attempt = 0;
        const build = vi.fn(async () => {
            if (++attempt === 1) throw new Error("transient");
            return "built";
        });
        const memo = memoAsync(build);

        await expect(memo.get()).rejects.toThrow("transient");
        await expect(memo.get()).resolves.toBe("built");
        expect(build).toHaveBeenCalledTimes(2);
    });

    it("peeks only once a value is ready, and never builds", async () => {
        const build = vi.fn(async () => "built");
        const memo = memoAsync(build);

        expect(memo.peek()).toBeUndefined();
        expect(build).not.toHaveBeenCalled();

        await memo.get();
        expect(memo.peek()).toBe("built");
    });

    it("exposes an in-flight build without starting one", async () => {
        // Teardown needs this: it must not start a build in order to tear
        // down, but must still await one already under way rather than
        // leaking what it was building.
        let release: (v: string) => void = () => {};
        const build = vi.fn(
            () =>
                new Promise<string>((r) => {
                    release = r;
                }),
        );
        const memo = memoAsync(build);

        expect(memo.inFlight()).toBeUndefined();
        expect(build).not.toHaveBeenCalled();

        const pending = memo.get();
        expect(memo.inFlight()).toBeDefined();
        expect(memo.peek()).toBeUndefined(); // started, not finished

        release("built");
        await pending;
        expect(memo.peek()).toBe("built");
    });

    it("reset drops both the promise and the value", async () => {
        const build = vi.fn(async () => "built");
        const memo = memoAsync(build);

        await memo.get();
        memo.reset();

        expect(memo.peek()).toBeUndefined();
        await memo.get();
        expect(build).toHaveBeenCalledTimes(2);
    });
});

describe("linkAbort", () => {
    it("aborts when the parent does", () => {
        const parent = new AbortController();
        const child = linkAbort(parent.signal);

        expect(child.signal.aborted).toBe(false);
        parent.abort(new Error("parent gone"));

        expect(child.signal.aborted).toBe(true);
        expect(child.signal.reason).toBeInstanceOf(Error);
    });

    it("honours a parent that already aborted", () => {
        // `addEventListener("abort", …)` never fires on an already-aborted
        // signal — the bug this helper exists to stop people rewriting.
        const child = linkAbort(AbortSignal.abort(new Error("already")));
        expect(child.signal.aborted).toBe(true);
    });

    it("aborts locally without touching the parent", () => {
        const parent = new AbortController();
        const child = linkAbort(parent.signal);

        child.abort(new Error("local timeout"));

        expect(child.signal.aborted).toBe(true);
        expect(parent.signal.aborted).toBe(false);
    });

    it("stops following the parent once disposed", () => {
        const parent = new AbortController();
        const child = linkAbort(parent.signal);

        child.dispose();
        parent.abort();

        expect(child.signal.aborted).toBe(false);
    });

    it("works with no parent at all", () => {
        const child = linkAbort(undefined);
        expect(child.signal.aborted).toBe(false);
        child.abort();
        expect(child.signal.aborted).toBe(true);
        expect(() => child.dispose()).not.toThrow();
    });
});
