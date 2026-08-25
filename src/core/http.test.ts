import { describe, expect, it, vi } from "vitest";
import { createHttpClient, type HttpClientOptions, redactUrl } from "./http.js";
import { createJsonClient } from "./json-client.js";

describe("redactUrl", () => {
    it("redacts the subscription bearer token in a query string", () => {
        expect(redactUrl("https://fmd.example/v1/matches?token=deadbeef&limit=10")).toBe(
            "https://fmd.example/v1/matches?token=REDACTED&limit=10",
        );
    });

    it("redacts the bearer token in the DELETE path segment", () => {
        expect(redactUrl("https://fmd.example/v1/subscriptions/deadbeef")).toBe(
            "https://fmd.example/v1/subscriptions/REDACTED",
        );
    });

    it("leaves the collection path alone", () => {
        expect(redactUrl("https://fmd.example/v1/subscriptions")).toBe(
            "https://fmd.example/v1/subscriptions",
        );
    });

    it("matches secret param names case-insensitively", () => {
        expect(redactUrl("https://r.example/scan?fmdSecret=abc")).toBe(
            "https://r.example/scan?fmdSecret=REDACTED",
        );
    });

    it("keeps ordinary params readable", () => {
        const u = "https://fmd.example/v1/notes?chainId=31337&limit=64&after=8";
        expect(redactUrl(u)).toBe(u);
    });

    it("refuses to pass through a URL it cannot parse", () => {
        expect(redactUrl("not a url?token=deadbeef")).toBe("<unparseable url>");
    });
});

describe("createHttpClient cancellation", () => {
    const client = (fetchImpl: typeof fetch, opts: Partial<HttpClientOptions> = {}) =>
        createHttpClient("RELAYER_TIMEOUT", "RELAYER_FAILED", {
            fetchImpl,
            backoffMs: 1,
            ...opts,
        });

    it("aborts the underlying request when the attempt times out", async () => {
        const seen: AbortSignal[] = [];
        const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
            if (init?.signal) seen.push(init.signal);
            // Never settles on its own: only the timeout can end this attempt.
            return new Promise<Response>(() => {});
        }) as unknown as typeof fetch;

        await expect(
            client(fetchImpl, { timeoutMs: 5, retries: 0 }).fetch("https://x.test/a"),
        ).rejects.toMatchObject({ code: "RELAYER_TIMEOUT" });

        expect(seen).toHaveLength(1);
        // Without this the connection stays open beside the retry.
        expect(seen[0]?.aborted).toBe(true);
    });

    it("gives each attempt its own signal, so a retry is not born aborted", async () => {
        const seen: AbortSignal[] = [];
        let calls = 0;
        const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
            if (init?.signal) seen.push(init.signal);
            if (++calls === 1) return new Promise<Response>(() => {});
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;

        const res = await client(fetchImpl, { timeoutMs: 5, retries: 1 }).fetch("https://x.test/a");

        expect(res.ok).toBe(true);
        expect(seen).toHaveLength(2);
        expect(seen[0]?.aborted).toBe(true);
        expect(seen[1]?.aborted).toBe(false);
    });

    it("does not retry a request the caller cancelled", async () => {
        const ctrl = new AbortController();
        const fetchImpl = vi.fn(async () => {
            ctrl.abort(new Error("user navigated away"));
            throw Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
        }) as unknown as typeof fetch;

        // A caller abort surfaces as an `AbortError` exactly like a timeout,
        // so treating it as transient retried work nobody wanted any more.
        await expect(
            client(fetchImpl, { retries: 3 }).fetch("https://x.test/a", { signal: ctrl.signal }),
        ).rejects.toThrow("user navigated away");

        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("issues nothing at all for an already-aborted signal", async () => {
        const fetchImpl = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;

        await expect(
            client(fetchImpl).fetch("https://x.test/a", {
                signal: AbortSignal.abort(new Error("gone")),
            }),
        ).rejects.toThrow("gone");

        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("still retries a genuine transient failure", async () => {
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            if (++calls < 3) return new Response("nope", { status: 503 });
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;

        const res = await client(fetchImpl, { retries: 3 }).fetch("https://x.test/a");

        expect(res.ok).toBe(true);
        expect(calls).toBe(3);
    });
});

describe("createJsonClient error messages", () => {
    it("redacts credentials in a non-JSON response error", async () => {
        const fetchImpl = vi.fn(
            async () => new Response("<html>gateway</html>", { status: 200 }),
        ) as unknown as typeof fetch;

        const json = createJsonClient(
            "https://fmd.test",
            { timeout: "FMD_TIMEOUT", failure: "FMD_FAILED" },
            { fetchImpl, retries: 0 },
        );

        // The transport layer redacts; the JSON layer used to interpolate the
        // raw URL, putting the detection key straight into the log line.
        await expect(json.get("/v1/notes", { params: { detectionKey: "s3cret" } })).rejects.toThrow(
            /REDACTED/,
        );
        await expect(
            json.get("/v1/notes", { params: { detectionKey: "s3cret" } }),
        ).rejects.not.toThrow(/s3cret/);
    });
});
