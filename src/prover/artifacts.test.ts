import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheApiArtifactCache, clearArtifactCache } from "./artifact-cache.js";
import {
    __resetArtifactCacheForTest,
    configureArtifactCache,
    loadArtifactBytes,
    releaseArtifactBytes,
    resolveArtifacts,
} from "./artifacts.js";

// The zkey is ~49 MB at the default 3x3 shape and was re-downloaded on every
// page load *and* every worker spawn before persistence existed. These pin the
// two properties that make it worth having: a hit never touches the network,
// and no storage failure can turn into a failed proof.
//
// They are also the first coverage of `loadArtifactBytes` at all, so the retry
// and status-classification paths are asserted here too.

const ZKEY = "https://cdn.test/3x3_final.zkey";
const BYTES = new Uint8Array([1, 2, 3, 4]);

/**
 * Minimal in-memory stand-in for the Cache API, keyed by request URL.
 *
 * Entries are `ArrayBuffer` rather than `Uint8Array` because `BodyInit`
 * rejects SharedArrayBuffer-backed views and plain `Uint8Array` is generic
 * over both — storing buffers sidesteps the variance entirely. Only one cache
 * name is ever in play, so there is no outer namespace.
 */
function fakeCaches(): { entries: Map<string, ArrayBuffer>; open: ReturnType<typeof vi.fn> } {
    const entries = new Map<string, ArrayBuffer>();
    const open = vi.fn(async () => ({
        match: async (url: string) => {
            const hit = entries.get(url);
            return hit ? new Response(hit) : undefined;
        },
        put: async (url: string, res: Response) => {
            entries.set(url, await res.arrayBuffer());
        },
    }));
    vi.stubGlobal("caches", {
        open,
        delete: async () => {
            const had = entries.size > 0;
            entries.clear();
            return had;
        },
    });
    return { entries, open };
}

/** Seed a cache hit for `url`. */
function seed(entries: Map<string, ArrayBuffer>, url: string, bytes: Uint8Array): void {
    entries.set(url, bytes.slice().buffer);
}

function respondWith(body: BodyInit): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async () => new Response(body, { status: 200 }));
    vi.stubGlobal("fetch", mock);
    return mock;
}

beforeEach(() => __resetArtifactCacheForTest());

afterEach(() => {
    vi.unstubAllGlobals();
    __resetArtifactCacheForTest();
});

describe("loadArtifactBytes persistence", () => {
    it("serves a cached artifact without touching the network", async () => {
        const { entries } = fakeCaches();
        seed(entries, ZKEY, BYTES);
        const fetchMock = respondWith(new Uint8Array([9, 9]));

        expect(await loadArtifactBytes(ZKEY)).toEqual(BYTES);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("writes through on a miss, so a fresh realm hits", async () => {
        fakeCaches();
        const fetchMock = respondWith(BYTES);

        expect(await loadArtifactBytes(ZKEY)).toEqual(BYTES);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // A worker is a separate JS realm: same origin-scoped Cache API, but a
        // fresh in-memory map. Dropping the memo is what simulates that.
        __resetArtifactCacheForTest();
        expect(await loadArtifactBytes(ZKEY)).toEqual(BYTES);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("reports one terminal progress event on a hit", async () => {
        const { entries } = fakeCaches();
        seed(entries, ZKEY, BYTES);
        respondWith(new Uint8Array());
        const seen: Array<{ loaded: number; total?: number }> = [];

        await loadArtifactBytes(ZKEY, { onProgress: (p) => seen.push(p) });

        // Without this a progress bar sits at 0% forever on a cache hit.
        expect(seen).toEqual([{ loaded: 4, total: 4, url: ZKEY }]);
    });

    it("still resolves when the cache write fails", async () => {
        vi.stubGlobal("caches", {
            open: async () => ({
                match: async () => undefined,
                put: async () => {
                    throw new DOMException("quota", "QuotaExceededError");
                },
            }),
        });
        respondWith(BYTES);

        await expect(loadArtifactBytes(ZKEY)).resolves.toEqual(BYTES);
    });

    it("still resolves when the cache read fails", async () => {
        vi.stubGlobal("caches", {
            open: async () => {
                throw new Error("storage disabled");
            },
        });
        const fetchMock = respondWith(BYTES);

        await expect(loadArtifactBytes(ZKEY)).resolves.toEqual(BYTES);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("honours an explicit opt-out", async () => {
        const { open } = fakeCaches();
        configureArtifactCache(false);
        respondWith(BYTES);

        await loadArtifactBytes(ZKEY);

        expect(open).not.toHaveBeenCalled();
    });

    it("routes through a custom cache", async () => {
        const get = vi.fn(async () => null);
        const put = vi.fn(async () => {});
        configureArtifactCache({ get, put });
        respondWith(BYTES);

        await loadArtifactBytes(ZKEY);

        expect(get).toHaveBeenCalledWith(ZKEY);
        expect(put).toHaveBeenCalledWith(ZKEY, BYTES);
    });

    it("is a no-op when the Cache API is absent", async () => {
        // Node, and browsers in a non-secure context.
        vi.stubGlobal("caches", undefined);
        const fetchMock = respondWith(BYTES);

        await expect(loadArtifactBytes(ZKEY)).resolves.toEqual(BYTES);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});

describe("releaseArtifactBytes", () => {
    it("drops the memo but leaves the persistent entry, so a reload is a hit", async () => {
        fakeCaches();
        const fetchMock = respondWith(BYTES);

        expect(await loadArtifactBytes(ZKEY)).toEqual(BYTES);
        // The wasm prover parses the ~49 MB zkey into linear memory and never
        // reads the Uint8Array again; without this the realm holds it twice.
        releaseArtifactBytes(ZKEY);
        expect(await loadArtifactBytes(ZKEY)).toEqual(BYTES);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("ignores paths it never held", () => {
        expect(() => releaseArtifactBytes("https://cdn.test/never-loaded")).not.toThrow();
    });
});

describe("resolveArtifacts", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("leaves filesystem paths alone when there is no document", () => {
        // Node: a bare string is a path, and `new URL()` would corrupt it.
        expect(resolveArtifacts({ wasmPath: "/tmp/3x3.wasm", zkeyPath: "/tmp/3x3.zkey" })).toEqual({
            wasmPath: "/tmp/3x3.wasm",
            zkeyPath: "/tmp/3x3.zkey",
        });
    });

    it("absolutises a page-relative base in a browser", () => {
        // A self-hosted app passing `proverArtifactsCdn: "/artifacts"` fetches
        // fine but fails `isHttpUrl`, silently losing artifact persistence.
        vi.stubGlobal("location", { href: "https://app.test/wallet/" });
        expect(resolveArtifacts({ wasmPath: "/artifacts/3x3.wasm", zkeyPath: "3x3.zkey" })).toEqual(
            {
                wasmPath: "https://app.test/artifacts/3x3.wasm",
                zkeyPath: "https://app.test/wallet/3x3.zkey",
            },
        );
    });

    it("gives two spellings of one artifact the same key", () => {
        vi.stubGlobal("location", { href: "https://app.test/wallet/" });
        const a = resolveArtifacts({ wasmPath: "/a/c.wasm", zkeyPath: "/a/k.zkey" });
        const b = resolveArtifacts({
            wasmPath: "https://app.test/a/c.wasm",
            zkeyPath: "https://app.test/a/k.zkey",
        });
        // Divergent keys mean two downloads and two prover sessions.
        expect(a).toEqual(b);
    });
});

describe("cacheApiArtifactCache", () => {
    it("degrades to nothing when the Cache API is absent", async () => {
        vi.stubGlobal("caches", undefined);
        expect(cacheApiArtifactCache()).toBeNull();
        expect(await clearArtifactCache()).toBe(false);
    });

    it("refuses non-http keys", async () => {
        // `cache.put` throws on a non-http Request; skipping beats throwing.
        const { open } = fakeCaches();
        const cache = cacheApiArtifactCache();
        expect(cache).not.toBeNull();

        expect(await cache?.get("file:///tmp/3x3_final.zkey")).toBeNull();
        await cache?.put("file:///tmp/3x3_final.zkey", BYTES);
        expect(open).not.toHaveBeenCalled();
    });

    it("clears", async () => {
        fakeCaches();
        const cache = cacheApiArtifactCache();
        await cache?.put(ZKEY, BYTES);
        expect(await cache?.get(ZKEY)).toEqual(BYTES);

        expect(await clearArtifactCache()).toBe(true);
        expect(await cache?.get(ZKEY)).toBeNull();
    });
});

describe("loadArtifactBytes network handling", () => {
    beforeEach(() => {
        vi.stubGlobal("caches", undefined);
    });

    it("retries a 500 and succeeds", async () => {
        let calls = 0;
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                calls += 1;
                return calls === 1 ? new Response(null, { status: 500 }) : new Response(BYTES);
            }),
        );

        await expect(loadArtifactBytes(`${ZKEY}?flaky`)).resolves.toEqual(BYTES);
        expect(calls).toBe(2);
    });

    it("does not retry a 404", async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
        vi.stubGlobal("fetch", fetchMock);

        await expect(loadArtifactBytes(`${ZKEY}?missing`)).rejects.toThrow(/404/);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("evicts a failed load so the caller can retry", async () => {
        const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
        vi.stubGlobal("fetch", fetchMock);
        const url = `${ZKEY}?evict`;

        await expect(loadArtifactBytes(url)).rejects.toThrow();
        await expect(loadArtifactBytes(url)).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("reports cumulative download progress", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(
                        new ReadableStream({
                            start(c) {
                                c.enqueue(new Uint8Array([1, 2]));
                                c.enqueue(new Uint8Array([3, 4]));
                                c.close();
                            },
                        }),
                        { headers: { "content-length": "4" } },
                    ),
            ),
        );
        const seen: number[] = [];

        const out = await loadArtifactBytes(`${ZKEY}?stream`, {
            onProgress: (p) => seen.push(p.loaded),
        });

        expect(seen).toEqual([2, 4]);
        expect(out).toEqual(BYTES);
    });

    it("assembles a streamed body that declares no length", async () => {
        // No `content-length` means the destination cannot be preallocated, so
        // this takes the chunk-list fallback rather than the direct-write path.
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(
                        new ReadableStream({
                            start(c) {
                                c.enqueue(new Uint8Array([1, 2]));
                                c.enqueue(new Uint8Array([3, 4]));
                                c.close();
                            },
                        }),
                    ),
            ),
        );
        const seen: Array<number | undefined> = [];

        const out = await loadArtifactBytes(`${ZKEY}?nolength`, {
            onProgress: (p) => seen.push(p.total),
        });

        expect(out).toEqual(BYTES);
        expect(seen).toEqual([undefined, undefined]);
    });

    it("recovers when the body outruns its declared content-length", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(
                async () =>
                    new Response(
                        new ReadableStream({
                            start(c) {
                                c.enqueue(new Uint8Array([1, 2]));
                                c.enqueue(new Uint8Array([3, 4]));
                                c.close();
                            },
                        }),
                        { headers: { "content-length": "3" } },
                    ),
            ),
        );

        // The second chunk does not fit the preallocated 3 bytes; it spills to
        // the fallback list and the two halves are merged in order.
        await expect(loadArtifactBytes(`${ZKEY}?short`)).resolves.toEqual(BYTES);
    });
});
