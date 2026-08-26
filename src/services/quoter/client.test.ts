import { describe, expect, it } from "vitest";
import { isWalletError } from "../../core/errors.js";
import { fetchSwapQuote, quoteAgeSecs, type SwapQuoteRequest } from "./client.js";

const REQ: SwapQuoteRequest = {
    chainId: 31337n,
    tokenIn: "0x1111111111111111111111111111111111111111",
    tokenOut: "0x2222222222222222222222222222222222222222",
    amountIn: 1_000_000n,
    slippageBps: 50,
};

const WIRE = {
    venue: "univ3",
    adapter: "0x3333333333333333333333333333333333333333",
    route: "0xdeadbeef",
    expected_out: "990000",
    min_out: "985050",
    gas_estimate: 210_000,
    quoted_at: 1_700_000_000,
};

/** A `fetch` stub that answers every call with `body` at `status`. */
function respond(body: unknown, status = 200): { impl: typeof fetch; calls: Request[] } {
    const calls: Request[] = [];
    const impl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push(new Request(url instanceof Request ? url : String(url), init));
        return new Response(typeof body === "string" ? body : JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json" },
        });
    }) as unknown as typeof fetch;
    return { impl, calls };
}

describe("fetchSwapQuote", () => {
    it("parses the snake_case wire form into bigints", async () => {
        const { impl, calls } = respond(WIRE);
        const q = await fetchSwapQuote("https://quoter.test", REQ, { fetchImpl: impl });

        expect(q).toEqual({
            venue: "univ3",
            adapter: WIRE.adapter,
            route: "0xdeadbeef",
            expectedOut: 990_000n,
            minOut: 985_050n,
            gasEstimate: 210_000,
            quotedAt: 1_700_000_000,
        });
        expect(calls[0]?.url).toBe("https://quoter.test/v1/quotes");
        expect(calls[0]?.method).toBe("POST");
    });

    it("trims a trailing slash off baseUrl", async () => {
        const { impl, calls } = respond(WIRE);
        await fetchSwapQuote("https://quoter.test/", REQ, { fetchImpl: impl });
        expect(calls[0]?.url).toBe("https://quoter.test/v1/quotes");
    });

    it("sends the request as snake_case with a numeric chain id", async () => {
        const { impl, calls } = respond(WIRE);
        await fetchSwapQuote("https://quoter.test", REQ, { fetchImpl: impl });
        expect(await calls[0]?.json()).toEqual({
            chain_id: 31337,
            token_in: REQ.tokenIn,
            token_out: REQ.tokenOut,
            amount_in: "1000000",
            slippage_bps: 50,
        });
    });

    // The whole point of moving this onto `json-client`: a quote failure used
    // to be a bare `Error` subclass that `isWalletError` returned false for,
    // so a caller could not tell it apart from a bug in its own code.
    it("reports an HTTP failure as a typed QUOTER_FAILED", async () => {
        const { impl } = respond("no route", 503);
        let thrown: unknown;
        try {
            await fetchSwapQuote("https://quoter.test", REQ, { fetchImpl: impl, retries: 0 });
        } catch (err) {
            thrown = err;
        }
        expect(isWalletError(thrown, "QUOTER_FAILED")).toBe(true);
        if (!isWalletError(thrown, "QUOTER_FAILED")) throw new Error("unreachable");
        // Narrowing that only compiles because `AnyWalletError` expands
        // `NetworkError` one code per member.
        expect(thrown.status).toBe(503);
        expect(thrown.body).toBe("no route");
        expect(thrown.url).toBe("https://quoter.test/v1/quotes");
    });

    it("retries a transient failure, which the old hand-rolled client never did", async () => {
        let n = 0;
        const impl = (async () => {
            n++;
            return n === 1
                ? new Response("busy", { status: 503 })
                : new Response(JSON.stringify(WIRE), {
                      status: 200,
                      headers: { "content-type": "application/json" },
                  });
        }) as unknown as typeof fetch;

        const q = await fetchSwapQuote("https://quoter.test", REQ, {
            fetchImpl: impl,
            backoffMs: 1,
        });
        expect(n).toBe(2);
        expect(q.minOut).toBe(985_050n);
    });

    it("honours a caller abort", async () => {
        const ctrl = new AbortController();
        ctrl.abort(new Error("caller gave up"));
        const { impl } = respond(WIRE);
        await expect(
            fetchSwapQuote("https://quoter.test", REQ, { fetchImpl: impl, signal: ctrl.signal }),
        ).rejects.toThrow("caller gave up");
    });

    // Each of these reached `BigInt(undefined)` or `Number(undefined)` under
    // the previous `as WireSwapQuote` cast, surfacing as a TypeError from
    // inside the deserializer with no indication of which field was wrong.
    it.each([
        ["a non-object body", [1, 2, 3], "$"],
        ["an unknown venue", { ...WIRE, venue: "sushi" }, "$.venue"],
        ["a missing amount", { ...WIRE, min_out: undefined }, "$.min_out"],
        ["a non-numeric amount", { ...WIRE, expected_out: "abc" }, "$.expected_out"],
        ["a short adapter", { ...WIRE, adapter: "0xabcd" }, "$.adapter"],
        ["an odd-length route", { ...WIRE, route: "0xabc" }, "$.route"],
        ["a fractional gas estimate", { ...WIRE, gas_estimate: 1.5 }, "$.gas_estimate"],
    ])("rejects %s with a WireFormatError naming the field", async (_label, body, path) => {
        const { impl } = respond(body);
        let thrown: unknown;
        try {
            await fetchSwapQuote("https://quoter.test", REQ, { fetchImpl: impl });
        } catch (err) {
            thrown = err;
        }
        expect(isWalletError(thrown, "WIRE_FORMAT")).toBe(true);
        if (!isWalletError(thrown, "WIRE_FORMAT")) throw new Error("unreachable");
        expect(thrown.path).toBe(path);
    });

    it("rejects a body that is not JSON at all", async () => {
        const { impl } = respond("<html>502</html>");
        await expect(
            fetchSwapQuote("https://quoter.test", REQ, { fetchImpl: impl }),
        ).rejects.toSatisfy((e: unknown) => isWalletError(e, "WIRE_FORMAT"));
    });
});

describe("quoteAgeSecs", () => {
    it("measures against the quote timestamp and never goes negative", () => {
        const q = { ...WIRE, quotedAt: 1_000 } as unknown as Parameters<typeof quoteAgeSecs>[0];
        expect(quoteAgeSecs(q, 1_030)).toBe(30);
        expect(quoteAgeSecs(q, 1_000)).toBe(0);
        // A clock behind the server's must not read as a fresh quote.
        expect(quoteAgeSecs(q, 900)).toBe(0);
    });
});
