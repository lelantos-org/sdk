import { describe, expect, it, vi } from "vitest";
import { NetworkError } from "../../errors/network.js";
import { RelayerClient } from "../relayer/client.js";
import { createHttpClient, type HttpClientOptions } from "./client.js";
import { createJsonClient } from "./json-client.js";
import { redactUrl } from "./redact.js";

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
            fetch: fetchImpl,
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

        // A caller abort surfaces as an `AbortError` like a timeout, but must
        // not be retried as a transient failure.
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

describe("createHttpClient submit deadline", () => {
    // A fetch that settles only when its attempt is aborted, so the deadline in
    // force is whichever one ends it first.
    const hangs = vi.fn(
        async (_u: string, init?: RequestInit) =>
            new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            }),
    ) as unknown as typeof fetch;
    const client = (opts: Partial<HttpClientOptions>) =>
        createHttpClient("RELAYER_TIMEOUT", "RELAYER_FAILED", {
            fetch: hangs,
            retries: 0,
            ...opts,
        });

    it("bounds a submit by submitTimeoutMs, over timeoutMs", async () => {
        await expect(
            client({ timeoutMs: 60_000, submitTimeoutMs: 5 }).fetch("https://x.test/v1/spend", {
                method: "POST",
            }),
        ).rejects.toMatchObject({ code: "RELAYER_TIMEOUT", message: /5ms/ });
    });

    it("leaves reads on timeoutMs", async () => {
        await expect(
            client({ timeoutMs: 5, submitTimeoutMs: 60_000 }).fetch("https://x.test/chains"),
        ).rejects.toMatchObject({ code: "RELAYER_TIMEOUT", message: /\(5ms\)/ });
    });

    it("still applies timeoutMs to a submit when no submit deadline is set", async () => {
        await expect(
            client({ timeoutMs: 5 }).fetch("https://x.test/v1/spend", { method: "POST" }),
        ).rejects.toMatchObject({ code: "RELAYER_TIMEOUT", message: /\(5ms\)/ });
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
            { fetch: fetchImpl, retries: 0 },
        );

        // Both layers must redact: interpolating the raw URL would put the
        // detection key into the log line.
        await expect(json.get("/v1/notes", { params: { detectionKey: "s3cret" } })).rejects.toThrow(
            /REDACTED/,
        );
        await expect(
            json.get("/v1/notes", { params: { detectionKey: "s3cret" } }),
        ).rejects.not.toThrow(/s3cret/);
    });
});

describe("createHttpClient retry history", () => {
    const client = (fetchImpl: typeof fetch, opts: Partial<HttpClientOptions> = {}) =>
        createHttpClient("RELAYER_TIMEOUT", "RELAYER_FAILED", {
            fetch: fetchImpl,
            backoffMs: 1,
            ...opts,
        });
    const POST = { method: "POST", body: "{}" };

    it("reports the final attempt's own status, not an earlier 5xx", async () => {
        let calls = 0;
        const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
            if (++calls === 1) return new Response("bad gateway", { status: 503 });
            // The second attempt never gets an answer.
            return new Promise<Response>((_, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            });
        }) as unknown as typeof fetch;

        const err = await client(fetchImpl, { retries: 1, submitTimeoutMs: 5 })
            .fetch("https://x.test/v1/spend", POST)
            .catch((e: unknown) => e);

        expect(err).toBeInstanceOf(NetworkError);
        const net = err as NetworkError;
        expect(net.code).toBe("RELAYER_TIMEOUT");
        // A timeout is "no response": borrowing the 503 would make a submit
        // that may have landed look definitely refused.
        expect(net.status).toBeUndefined();
        expect(net.body).toBeUndefined();
        expect(net.attempts).toEqual([{ status: 503, body: "bad gateway" }, {}]);
    });

    it.each([500, 502])("never resends a submit answered %i", async (status) => {
        const fetchImpl = vi.fn(
            async () => new Response("outcome unknown", { status }),
        ) as unknown as typeof fetch;

        await expect(
            client(fetchImpl, { retries: 3 }).fetch("https://x.test/v1/spend", POST),
        ).rejects.toMatchObject({ status, attempts: [{ status }] });
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    it.each([
        429, 503,
    ])("retries a submit refused with %i, under one Idempotency-Key", async (status) => {
        const keys: string[] = [];
        let calls = 0;
        const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
            keys.push((init?.headers as Record<string, string>)["Idempotency-Key"]!);
            if (++calls === 1) return new Response("busy", { status });
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;

        const res = await client(fetchImpl, { retries: 3 }).fetch("https://x.test/v1/spend", POST);

        expect(res.ok).toBe(true);
        expect(keys).toHaveLength(2);
        expect(keys[0]).toBe(keys[1]);
    });

    it("adds configured headers to every request, under per-request ones and the key", async () => {
        const seen: Record<string, string>[] = [];
        const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
            seen.push(init?.headers as Record<string, string>);
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;
        const c = client(fetchImpl, { headers: { "x-api-key": "k", "x-over": "base" } });

        await c.fetch("https://x.test/v1/read");
        await c.fetch("https://x.test/v1/spend", { ...POST, headers: { "x-over": "call" } });

        expect(seen[0]).toMatchObject({ "x-api-key": "k", "x-over": "base" });
        expect(seen[1]).toMatchObject({ "x-api-key": "k", "x-over": "call" });
        expect(seen[1]?.["Idempotency-Key"]).toBeDefined();
    });

    // Retries key on idempotency, not method: the relayer's estimates are POSTs that only read.
    it.each([500, 502])("retries a POST declared idempotent on %i", async (status) => {
        const headers: (Record<string, string> | undefined)[] = [];
        const inits: (RequestInit | undefined)[] = [];
        let calls = 0;
        const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => {
            inits.push(init);
            headers.push(init?.headers as Record<string, string> | undefined);
            if (++calls === 1) return new Response("oops", { status });
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;

        const res = await client(fetchImpl, { retries: 3 }).fetch(
            "https://x.test/v1/spend/estimate",
            {
                ...POST,
                idempotent: true,
            },
        );
        expect(res.ok).toBe(true);
        expect(calls).toBe(2);
        // A read carries no Idempotency-Key, and the switch never reaches `fetch`.
        expect(headers[0]?.["Idempotency-Key"]).toBeUndefined();
        expect(inits[0]).not.toHaveProperty("idempotent");
    });

    it("retries the relayer's estimate endpoints on 502", async () => {
        const seen: string[] = [];
        const fetchImpl = vi.fn(async (u: string) => {
            seen.push(new URL(u).pathname);
            const first = seen.filter((p) => p === new URL(u).pathname).length === 1;
            return first
                ? new Response("bad gateway", { status: 502 })
                : new Response(JSON.stringify({ fees: [] }), { status: 200 });
        }) as unknown as typeof fetch;
        const relayer = new RelayerClient("https://relayer.test", {
            fetch: fetchImpl,
            backoffMs: 1,
            retries: 2,
        });

        await expect(relayer.estimateSpend(1n, "transfer")).resolves.toEqual({ fees: [] });
        await expect(relayer.estimateSwap(1n)).resolves.toEqual({ fees: [] });
        await expect(relayer.estimateDeposit(1n)).resolves.toEqual({ fees: [] });

        const count = (p: string) => seen.filter((x) => x === p).length;
        expect(count("/v1/spend/estimate")).toBe(2);
        expect(count("/v1/swap/estimate")).toBe(2);
        expect(count("/v1/deposit/estimate")).toBe(2);
        // Submits stay on the non-idempotent policy: see "never resends a submit answered %i".
    });

    it("still retries a read on 500", async () => {
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            if (++calls === 1) return new Response("oops", { status: 500 });
            return new Response("{}", { status: 200 });
        }) as unknown as typeof fetch;

        const res = await client(fetchImpl, { retries: 3 }).fetch("https://x.test/chains");
        expect(res.ok).toBe(true);
        expect(calls).toBe(2);
    });

    it("rejects with the caller's reason when aborted between attempts", async () => {
        const ctrl = new AbortController();
        const reason = new Error("user cancelled");
        const fetchImpl = vi.fn(
            async () => new Response("busy", { status: 503 }),
        ) as unknown as typeof fetch;

        await expect(
            client(fetchImpl, {
                retries: 3,
                backoffMs: 10_000,
                onRetry: () => ctrl.abort(reason),
            }).fetch("https://x.test/chains", { signal: ctrl.signal }),
        ).rejects.toBe(reason);
    });
});
