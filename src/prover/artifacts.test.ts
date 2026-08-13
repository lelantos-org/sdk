import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ARTIFACT_CACHE_NAME,
    cacheApiArtifactCache,
    clearArtifactCache,
} from "./artifact-cache.js";
import {
    __resetArtifactCacheForTest,
    configureArtifactCache,
    loadArtifactBytes,
} from "./artifacts.js";

// The zkey is ~49 MB at the default 3x3 shape and was re-downloaded on every
// page load *and* every worker spawn before persistence existed. These pin the
// two properties that makes worth having: a hit never touches the network, and
// no storage failure can turn into a failed proof.
//
// They are also the first coverage of `loadArtifactBytes` at all, so the retry
// and status-classification paths are asserted here too.

const ZKEY = "https://cdn.test/3x3_final.zkey";
const BYTES = new Uint8Array([1, 2, 3, 4]);

/**
 * Minimal in-memory stand-in for the Cache API, keyed by request URL.
 *
 * `Uint8Array<ArrayBuffer>` rather than plain `Uint8Array`: `BodyInit` rejects
 * SharedArrayBuffer-backed views, and `Uint8Array` alone is generic over both.
 */
function fakeCaches(): {
    store: Map<string, Map<string, Uint8Array<ArrayBuffer>>>;
    open: ReturnType<typeof vi.fn>;
} {
    const store = new Map<string, Map<string, Uint8Array<ArrayBuffer>>>();
    const open = vi.fn(async (name: string) => {
        let entries = store.get(name);
        if (!entries) {
            entries = new Map();
            store.set(name, entries);
        }
        const own = entries;
        return {
            match: async (url: string) => {
                const hit = own.get(url);
                return hit ? new Response(hit) : undefined;
            },
            put: async (url: string, res: Response) => {
                own.set(url, new Uint8Array(await res.arrayBuffer()) as Uint8Array<ArrayBuffer>);
            },
        };
    });
    vi.stubGlobal("caches", { open, delete: async (n: string) => store.delete(n) });
    return { store, open };
}

function respondWith(bytes: Uint8Array<ArrayBuffer>): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async () => new Response(bytes, { status: 200 }));
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
        const { store } = fakeCaches();
        store.set(ARTIFACT_CACHE_NAME, new Map([[ZKEY, BYTES]]));
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
        const { store } = fakeCaches();
        store.set(ARTIFACT_CACHE_NAME, new Map([[ZKEY, BYTES]]));
        respondWith(new Uint8Array());
        const seen: Array<{ loaded: number; total?: number }> = [];

        await loadArtifactBytes(ZKEY, { onProgress: (p) => seen.push(p) });

        // Without this a progress bar sits at 0% forever on a cache hit.
        expect(seen).toEqual([{ loaded: 4, total: 4, url: ZKEY }]);
    });

    it("still resolves when the cache write fails", async () => {
        // QuotaExceededError is the realistic one at ~49 MB per shape.
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

describe("cacheApiArtifactCache", () => {
    it("is null without the Cache API", () => {
        vi.stubGlobal("caches", undefined);
        expect(cacheApiArtifactCache()).toBeNull();
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

    it("round-trips bytes", async () => {
        fakeCaches();
        const cache = cacheApiArtifactCache();
        await cache?.put(ZKEY, BYTES);
        expect(await cache?.get(ZKEY)).toEqual(BYTES);
    });

    it("clears", async () => {
        fakeCaches();
        const cache = cacheApiArtifactCache();
        await cache?.put(ZKEY, BYTES);
        expect(await clearArtifactCache()).toBe(true);
        expect(await cache?.get(ZKEY)).toBeNull();
    });

    it("reports false when clearing without the Cache API", async () => {
        vi.stubGlobal("caches", undefined);
        expect(await clearArtifactCache()).toBe(false);
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
});
