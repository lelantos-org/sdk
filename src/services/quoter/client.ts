// Quote-fetch helper for the MetaQuoter backend.
//
// Fetches the best route for `(tokenIn, tokenOut, amountIn)`. Proof bundling
// reuses `buildWithdraw` + `buildDeposit` from `bundle/`; the caller assembles
// `SwapWrapper.swap(SwapArgs)` calldata against its own signer/relayer.
//
// Built on `services/http/json-client.ts`, which provides the per-attempt timeout, retry
// with backoff, and URL redaction in errors and logs.
//
// Retrying is safe despite the POST: a quote reads a venue and moves nothing.

import { unixNow } from "../../core/time.js";
import { WireFormatError } from "../../errors/network.js";
import type { HttpClientOptions } from "../http/client.js";
import { bigintFrom, int, obj, str } from "../http/decode.js";
import { createJsonClient } from "../http/json-client.js";

/**
 * Venue tag returned by MetaQuoter.
 *
 * @internal
 */
export type SwapVenue = "univ3" | "univ4";

const VENUES: ReadonlySet<string> = new Set<SwapVenue>(["univ3", "univ4"]);

/**
 * Best route returned by `POST /v1/quotes`. All `bigint`-shaped fields
 * arrive as decimal strings on the wire; this type holds the parsed
 * `bigint` values.
 */
export interface SwapRouteQuote {
    venue: SwapVenue;
    /** Allowlisted `ISwapAdapter` address bound to the route on-chain. */
    adapter: `0x${string}`;
    /**
     * Adapter-specific opaque blob, hex-encoded. UniV3 single-hop:
     * `abi.encode(uint24 fee, uint160 sqrtPriceLimitX96)` (64B); set
     * `sqrtPriceLimitX96` to a tight bound around the quote to keep the
     * router's `SPL` check between the caller and the mempool. Multi-hop:
     * `abi.encodePacked` path bytes.
     *
     * UniV4 single-hop: `abi.encode(uint24 fee, int24 tickSpacing)` (64B).
     * Currency ordering is derived from the token addresses by the adapter and
     * `hooks` is pinned to the zero address, so neither appears here.
     */
    route: `0x${string}`;
    /** Quoter's expected output before slippage adjustment. */
    expectedOut: bigint;
    /**
     * `expectedOut * (10_000 - slippageBps) / 10_000`, the floor the
     * caller must encode as `pi.publicIn` on the deposit leg.
     */
    minOut: bigint;
    /** Wrapper-overhead-included gas estimate. */
    gasEstimate: number;
    /** Unix seconds at which the venue was queried. */
    quotedAt: number;
}

export interface SwapQuoteRequest {
    /** `bigint` to match `WalletConfig.chainId` and `ChainAdapter.chainId()`. */
    chainId: bigint;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    /** Max acceptable slippage in basis points (50 = 0.5%). */
    slippageBps: number;
}

/**
 * Transport options. Extends {@link HttpClientOptions}, so `retries`,
 * `backoffMs` and `onRetry` work here exactly as on the relayer and FMD
 * clients; `timeoutMs` keeps this client's shorter 5s default, since a stale
 * quote is worth less than a fast failure.
 *
 * @internal
 */
export interface FetchSwapQuoteOptions extends HttpClientOptions {
    signal?: AbortSignal | undefined;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Fetch the best route from MetaQuoter. `baseUrl` should be the root the
 * service is mounted on (no trailing `/v1/quotes`).
 *
 * Throws `NetworkError` (`QUOTER_TIMEOUT` / `QUOTER_FAILED`) on transport
 * failure and `WireFormatError` on a response that does not match the
 * contract above; both are `WalletError`s, so `isWalletError` recognises them.
 */
export async function fetchSwapQuote(
    baseUrl: string,
    req: SwapQuoteRequest,
    opts: FetchSwapQuoteOptions = {},
): Promise<SwapRouteQuote> {
    const { signal, ...http } = opts;
    const json = createJsonClient(
        baseUrl,
        { timeout: "QUOTER_TIMEOUT", failure: "QUOTER_FAILED" },
        { timeoutMs: DEFAULT_TIMEOUT_MS, ...http },
    );
    const raw = await json.post<unknown>(
        "/v1/quotes",
        {
            chain_id: Number(req.chainId),
            token_in: req.tokenIn,
            token_out: req.tokenOut,
            amount_in: req.amountIn.toString(),
            slippage_bps: req.slippageBps,
        },
        signal ? { signal } : {},
    );
    return swapQuote(raw);
}

/**
 * Validate the wire shape rather than asserting it.
 *
 * A type cast would surface a missing `min_out` as a `TypeError` from
 * `BigInt(undefined)` and an `expected_out` of `"abc"` as a `SyntaxError`,
 * neither naming the field. A quote sets how much a caller accepts from a swap,
 * so a malformed one must fail with the offending field named.
 */
function swapQuote(raw: unknown): SwapRouteQuote {
    const d = obj(raw, "$");
    const venue = str(d.venue, "$.venue");
    if (!VENUES.has(venue)) {
        throw new WireFormatError("$.venue", `unknown swap venue "${venue}"`);
    }
    return {
        venue: venue as SwapVenue,
        adapter: hexAddress(d.adapter, "$.adapter"),
        route: hexBlob(d.route, "$.route"),
        expectedOut: bigintFrom(d.expected_out, "$.expected_out"),
        minOut: bigintFrom(d.min_out, "$.min_out"),
        gasEstimate: int(d.gas_estimate, "$.gas_estimate"),
        quotedAt: int(d.quoted_at, "$.quoted_at"),
    };
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_BLOB = /^0x([0-9a-fA-F]{2})*$/;

/**
 * The adapter goes on-chain as an allowlisted `ISwapAdapter`. Checked for
 * width here so a truncated or `0x`-less value is reported against its field
 * rather than reverting the swap.
 */
function hexAddress(v: unknown, path: string): `0x${string}` {
    const s = str(v, path);
    if (!ADDRESS.test(s)) throw new WireFormatError(path, "expected a 0x-prefixed 20-byte address");
    return s as `0x${string}`;
}

/** Opaque to the SDK, but must be whole bytes of hex. */
function hexBlob(v: unknown, path: string): `0x${string}` {
    const s = str(v, path);
    if (!HEX_BLOB.test(s)) {
        throw new WireFormatError(path, "expected 0x-prefixed hex of whole bytes");
    }
    return s as `0x${string}`;
}

/** Quote age in seconds. Callers choose their own staleness threshold. */
export function quoteAgeSecs(q: SwapRouteQuote, nowSecs: number = unixNow()): number {
    return Math.max(0, nowSecs - q.quotedAt);
}
