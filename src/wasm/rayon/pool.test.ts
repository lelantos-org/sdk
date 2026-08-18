import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initBrowserThreadPool, type RayonModule } from "./pool.js";

// `initThreadPool` spawns all N workers before awaiting N readies, so a single
// worker that fails to boot leaves the promise unsettled until the timeout —
// and the N-1 that did boot parked in `Atomics.wait`, each holding a stack in
// the prover's shared wasm memory, which can never shrink.

describe("thread pool init", () => {
    // rayon needs SharedArrayBuffer, which the browser path gates on
    // COOP+COEP. Without the stub every case would exit as "not-isolated"
    // before reaching the behaviour under test.
    beforeEach(() => vi.stubGlobal("crossOriginIsolated", true));
    afterEach(() => vi.unstubAllGlobals());

    it("degrades to single-threaded when the module has no pool support", async () => {
        const outcome = await initBrowserThreadPool({} as RayonModule, {
            threadCount: 4,
            label: "test",
        });
        expect(outcome.threads).toBe(1);
    });

    it("degrades to single-threaded when one thread is requested", async () => {
        const initThreadPool = vi.fn(async () => undefined);
        const outcome = await initBrowserThreadPool(
            { initThreadPool },
            {
                threadCount: 1,
                label: "test",
            },
        );

        expect(outcome.threads).toBe(1);
        expect(initThreadPool).not.toHaveBeenCalled();
    });

    it("degrades to single-threaded rather than throwing when init rejects", async () => {
        // The failure path that used to strand the workers that did boot.
        const initThreadPool = vi.fn(async () => {
            throw new Error("PoolBuilder::build failed");
        });

        const outcome = await initBrowserThreadPool(
            { initThreadPool },
            {
                threadCount: 4,
                label: "test",
            },
        );

        expect(outcome.threads).toBe(1);
        expect(initThreadPool).toHaveBeenCalledOnce();
    });

    it("reports the requested thread count on success", async () => {
        const initThreadPool = vi.fn(async () => undefined);
        const outcome = await initBrowserThreadPool(
            { initThreadPool },
            {
                threadCount: 4,
                label: "test",
            },
        );

        expect(outcome.threads).toBe(4);
        expect(initThreadPool).toHaveBeenCalledWith(4);
    });
});
