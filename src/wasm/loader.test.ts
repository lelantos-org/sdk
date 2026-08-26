import { describe, expect, it, vi } from "vitest";
import { createWasmLoader, type WasmModuleBase } from "./loader.js";

// The loader memoises the module promise, which is what makes `load()` cheap
// to call from anywhere. Two properties make that memo safe rather than a
// trap: a rejection must not be cached, and teardown must be able to clear it.

type Mod = WasmModuleBase & { tag: string };

function loaderOver(init: () => Promise<Mod>, postInit?: () => void) {
    const loader = createWasmLoader<Mod>({
        name: "test",
        defaultImport: init,
        nodeWasmPath: async () => "/dev/null",
        nodeJsUrl: async () => "file:///dev/null",
        ...(postInit ? { postInit: async () => postInit() } : {}),
    });
    return loader;
}

const okModule = (tag = "m"): Mod => ({ tag, default: vi.fn(async () => undefined) }) as Mod;

describe("createWasmLoader", () => {
    it("memoises a successful load", async () => {
        const load = vi.fn(async () => okModule());
        const loader = loaderOver(load);

        loader.configure({ loadModule: load });
        await Promise.all([loader.load(), loader.load()]);
        await loader.load();

        expect(load).toHaveBeenCalledTimes(1);
    });

    it("does not cache a rejection", async () => {
        // A cached rejection — one EMFILE on the Node wasm read, one 502 on
        // the browser fetch, one `postInit` timeout — would be replayed to
        // every later caller in the realm, surviving a working loader
        // override.
        let attempt = 0;
        const load = vi.fn(async () => {
            if (++attempt === 1) throw new Error("transient");
            return okModule();
        });
        const loader = loaderOver(load);
        loader.configure({ loadModule: load });

        await expect(loader.load()).rejects.toThrow("transient");
        await expect(loader.load()).resolves.toMatchObject({ tag: "m" });
        expect(load).toHaveBeenCalledTimes(2);
    });

    it("reset() makes the next load re-run postInit", async () => {
        // `postInit` is what starts the rayon thread pool. Tearing the pool
        // down leaves the module loaded but unusable, so the memo has to be
        // droppable or the pool could never be rebuilt.
        const postInit = vi.fn();
        const load = vi.fn(async () => okModule());
        const loader = loaderOver(load, postInit);
        loader.configure({ loadModule: load });

        await loader.load();
        await loader.load();
        expect(postInit).toHaveBeenCalledTimes(1);

        loader.reset();
        await loader.load();

        expect(postInit).toHaveBeenCalledTimes(2);
    });

    it("configure() drops an existing memo", async () => {
        const first = vi.fn(async () => okModule("first"));
        const second = vi.fn(async () => okModule("second"));
        const loader = loaderOver(first);

        loader.configure({ loadModule: first });
        expect((await loader.load()).tag).toBe("first");

        loader.configure({ loadModule: second });
        expect((await loader.load()).tag).toBe("second");
    });
});
