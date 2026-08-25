import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cacheApiArtifactCache, clearArtifactCache } from "./artifact-cache.js";
import {
    __resetArtifactCacheForTest,
    configureArtifactCache,
    loadArtifactBytes,
    releaseArtifactBytes,
    resolveArtifacts,
} from "./artifacts.js";

// The zkey is ~29 MB at the default 3x3 shape and was re-downloaded on every
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

/**
 * Stub `fetch` with a chunked streaming body. Trailing object argument sets
 * response headers — `content-length` is what decides whether
 * `readWithProgress` can preallocate.
 */
function streamOf(...chunks: (number[] | Record<string, string>)[]): void {
    const last = chunks.at(-1);
    const headers = Array.isArray(last) ? undefined : (last as Record<string, string>);
    const data = (headers ? chunks.slice(0, -1) : chunks) as number[][];
    vi.stubGlobal(
        "fetch",
        vi.fn(
            async () =>
                new Response(
                    new ReadableStream({
                        start(c) {
                            for (const chunk of data) c.enqueue(new Uint8Array(chunk));
                            c.close();
                        },
                    }),
                    headers ? { headers } : undefined,
                ),
        ),
    );
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
        // The wasm prover parses the ~29 MB zkey into linear memory and never
        // reads the Uint8Array again; without this the realm holds it twice.
        releaseArtifactBytes(ZKEY);
        expect(await loadArtifactBytes(ZKEY)).toEqual(BYTES);

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("releases a page-relative path, which memoises under its absolute URL", async () => {
        // `WasmProver.build` is documented as taking caller-supplied paths
        // without passing them through `resolveArtifacts`, so a browser app
        // passing "/artifacts/3x3_final.zkey" is the ordinary case — and the
        // one where deleting the raw string matched no entry at all, pinning
        // ~29 MB for the lifetime of the realm. Every other test here uses an
        // already-absolute URL, where the mismatch cannot show.
        //
        // With persistence off, the memo is the only thing that can serve a
        // second load, so the fetch count reports whether the release landed.
        configureArtifactCache(false);
        vi.stubGlobal("location", { href: "https://app.test/wallet/" });
        const relative = "/artifacts/3x3_final.zkey";
        const fetchMock = respondWith(BYTES);

        expect(await loadArtifactBytes(relative)).toEqual(BYTES);
        expect(await loadArtifactBytes(relative)).toEqual(BYTES);
        expect(fetchMock).toHaveBeenCalledTimes(1); // memoised

        releaseArtifactBytes(relative);

        expect(await loadArtifactBytes(relative)).toEqual(BYTES);
        expect(fetchMock).toHaveBeenCalledTimes(2); // memo actually dropped
    });
});

describe("loadArtifactBytes cancellation", () => {
    it("does not download anything for an already-aborted signal", async () => {
        configureArtifactCache(false);
        const fetchMock = respondWith(BYTES);

        await expect(
            loadArtifactBytes(ZKEY, { signal: AbortSignal.abort(new Error("user left")) }),
        ).rejects.toThrow(/aborted by caller/);

        // `fetchArtifact` runs once per retry, so an abort that was ignored
        // meant every remaining attempt pulled the full artifact.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not retry after the caller aborts mid-download", async () => {
        configureArtifactCache(false);
        const ctrl = new AbortController();
        const fetchMock = vi.fn(async (_u: string, init?: RequestInit) => {
            ctrl.abort(new Error("user left"));
            const err = new Error("The operation was aborted.");
            err.name = "AbortError";
            void init;
            throw err;
        });
        vi.stubGlobal("fetch", fetchMock);

        await expect(loadArtifactBytes(ZKEY, { signal: ctrl.signal })).rejects.toThrow(
            /aborted by caller/,
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("still reports a genuine timeout as a timeout", async () => {
        configureArtifactCache(false);
        vi.stubGlobal(
            "fetch",
            vi.fn(
                (_u: string, init?: RequestInit) =>
                    new Promise<Response>((_res, rej) => {
                        init?.signal?.addEventListener("abort", () => {
                            const err = new Error("aborted");
                            err.name = "AbortError";
                            rej(err);
                        });
                    }),
            ),
        );

        await expect(loadArtifactBytes(ZKEY, { timeoutMs: 5 })).rejects.toThrow(/timed out/);
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

    it("absolutises page-relative references in a browser", () => {
        // A self-hosted app passing `proverArtifactsCdn: "/artifacts"` fetches
        // fine but fails `isHttpUrl`, silently losing artifact persistence.
        // Absolutising also means two spellings cannot become two cache keys,
        // hence two downloads and two prover sessions.
        vi.stubGlobal("location", { href: "https://app.test/wallet/" });
        const absolute = {
            wasmPath: "https://app.test/artifacts/3x3.wasm",
            zkeyPath: "https://app.test/wallet/3x3.zkey",
        };

        expect(resolveArtifacts({ wasmPath: "/artifacts/3x3.wasm", zkeyPath: "3x3.zkey" })).toEqual(
            absolute,
        );
        expect(resolveArtifacts(absolute)).toEqual(absolute);
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
        // Nothing to preallocate from, so this exercises growth from zero.
        streamOf([1, 2], [3, 4]);
        const seen: Array<number | undefined> = [];

        const out = await loadArtifactBytes(`${ZKEY}?nolength`, {
            onProgress: (p) => seen.push(p.total),
        });

        expect(out).toEqual(BYTES);
        expect(seen).toEqual([undefined, undefined]);
    });

    it("recovers when the body outruns its declared content-length", async () => {
        // The second chunk does not fit the 3 bytes the server promised, so the
        // buffer has to grow mid-stream. `onProgress` is required: without it
        // `fetchArtifact` takes `res.arrayBuffer()` and never streams at all.
        streamOf([1, 2], [3, 4], { "content-length": "3" });

        await expect(loadArtifactBytes(`${ZKEY}?short`, { onProgress: () => {} })).resolves.toEqual(
            BYTES,
        );
    });

    it("trims a body shorter than its declared content-length", async () => {
        // Over-declared: the result must be the 2 bytes received, and must not
        // retain the oversized buffer behind a view.
        streamOf([1, 2], { "content-length": "64" });

        const out = await loadArtifactBytes(`${ZKEY}?long`, { onProgress: () => {} });

        expect(out).toEqual(new Uint8Array([1, 2]));
        expect(out.buffer.byteLength).toBe(2);
    });
});
