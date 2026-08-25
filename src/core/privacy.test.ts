// Privacy invariants of the shared HTTP layer.
//
// Pins two properties that are invisible in normal use: what the SDK attaches
// to a request without being asked, and what it copies into an error the
// caller will log.

import { afterEach, describe, expect, it, vi } from "vitest";
import { InsufficientCoverError, NetworkError } from "./errors.js";
import { createHttpClient } from "./http.js";
import { createJsonClient } from "./json-client.js";

function fetchMock(body = "{}", status = 200): ReturnType<typeof vi.fn> {
    const mock = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal("fetch", mock);
    return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe("request defaults", () => {
    it("sends no referrer and no cookies", async () => {
        const mock = fetchMock();
        await createHttpClient("FMD_TIMEOUT", "FMD_FAILED").fetch("https://fmd.test/v1/notes");

        const init = mock.mock.calls[0]![1] as RequestInit;
        // Browser defaults put the page origin in `Referer` and attach
        // same-origin cookies. Neither is read by any Lelantos service.
        expect(init.referrerPolicy).toBe("no-referrer");
        expect(init.credentials).toBe("omit");
        expect(init.cache).toBe("no-store");
    });

    it("lets the caller override them", async () => {
        const mock = fetchMock();
        await createHttpClient("FMD_TIMEOUT", "FMD_FAILED").fetch("https://fmd.test/v1/notes", {
            credentials: "include",
        });

        expect((mock.mock.calls[0]![1] as RequestInit).credentials).toBe("include");
    });
});

describe("JSON layer", () => {
    it("forwards per-request headers on POST, so a credential need not go in the URL", async () => {
        const mock = fetchMock();
        const client = createJsonClient("https://fmd.test", {
            timeout: "FMD_TIMEOUT",
            failure: "FMD_FAILED",
        });

        await client.post(
            "/v1/subscriptions",
            { a: 1 },
            { headers: { Authorization: "Bearer x" } },
        );

        const init = mock.mock.calls[0]![1] as RequestInit;
        expect(init.headers).toMatchObject({ Authorization: "Bearer x" });
        // The content-type default survives the merge.
        expect(init.headers).toMatchObject({ "content-type": "application/json" });
    });
});

describe("NetworkError", () => {
    it("keeps the response body off the message", async () => {
        // A relayer 4xx may echo part of the submitted payload. It stays
        // reachable as a field; the message is what reaches logs.
        fetchMock('{"detail":"nullifier 0xdead already spent"}', 400);
        const client = createJsonClient("https://relayer.test", {
            timeout: "RELAYER_TIMEOUT",
            failure: "RELAYER_FAILED",
        });

        const err = await client.post("/v1/spend", {}).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(NetworkError);
        const net = err as NetworkError;
        expect(net.message).not.toContain("0xdead");
        expect(net.body).toContain("0xdead");
    });
});

describe("InsufficientCoverError", () => {
    it("carries no note secrets", () => {
        // Thrown on the ordinary cover-failure path, so it reaches application
        // error reporting.
        const err = new InsufficientCoverError({
            target: 10n,
            asset: 1n,
            consolidate: [{ id: "abc", value: "3" }],
            consolidateSum: 4n,
        });

        const serialised = JSON.stringify({ ...err, message: err.message }, (_k, v) =>
            typeof v === "bigint" ? v.toString() : v,
        );
        for (const secret of ["rho", "rcm", "rcvDep", "cm", "leafIndex"]) {
            expect(serialised).not.toContain(secret);
        }
        // Amounts and ids remain readable as fields, but not in the message.
        expect(err.message).not.toContain("abc");
        expect(err.consolidate[0]).toEqual({ id: "abc", value: "3" });
    });
});
