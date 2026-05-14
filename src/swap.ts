// Quote-fetch helper for the MetaQuoter backend.
//
// Fetches the best route for `(tokenIn, tokenOut, amountIn)`. Proof bundling
// reuses `buildWithdraw` + `buildDeposit` from `bundle.ts`; caller assembles
// `SwapWrapper.swap(SwapArgs)` calldata against their own signer/relayer.

/// Venue tag returned by MetaQuoter. Extend as additional adapters land.
export type SwapVenue = "univ3";

/// Best route returned by `POST /v1/quotes`. All `bigint`-shaped fields
/// arrive as decimal strings on the wire; this type holds the parsed
/// `bigint` values.
export interface SwapQuote {
    venue: SwapVenue;
    /// Allowlisted `ISwapAdapter` address bound to the route on-chain.
    adapter: `0x${string}`;
    /// Adapter-specific opaque blob (UniV3 = abi.encode(uint24 fee), or
    /// abi.encodePacked path for multi-hop). Hex-encoded.
    route: `0x${string}`;
    /// Quoter's expected output before slippage adjustment.
    expectedOut: bigint;
    /// `expectedOut * (10_000 - slippageBps) / 10_000`, the floor the
    /// caller must encode as `pi.publicIn` on the deposit leg.
    minOut: bigint;
    /// Wrapper-overhead-included gas estimate.
    gasEstimate: number;
    /// Unix seconds at which the venue was queried.
    quotedAt: number;
}

export interface SwapQuoteRequest {
    chainId: number;
    tokenIn: `0x${string}`;
    tokenOut: `0x${string}`;
    amountIn: bigint;
    /// Max acceptable slippage in basis points (50 = 0.5%).
    slippageBps: number;
}

interface WireSwapQuote {
    venue: SwapVenue;
    adapter: `0x${string}`;
    route: `0x${string}`;
    expected_out: string;
    min_out: string;
    gas_estimate: number;
    quoted_at: number;
}

export interface FetchSwapQuoteOptions {
    /// Override the default global `fetch`. Lets tests stub the HTTP layer
    /// without monkey-patching globals.
    fetchImpl?: typeof fetch;
    /// Abort after this many ms; defaults to 5_000.
    timeoutMs?: number;
}

export class SwapQuoteError extends Error {
    constructor(
        public readonly status: number,
        message: string,
    ) {
        super(message);
        this.name = "SwapQuoteError";
    }
}

/// Fetch the best route from MetaQuoter. `baseUrl` should be the root the
/// service is mounted on (no trailing `/v1/quotes`).
export async function fetchSwapQuote(
    baseUrl: string,
    req: SwapQuoteRequest,
    opts: FetchSwapQuoteOptions = {},
): Promise<SwapQuote> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/v1/quotes`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                chain_id: req.chainId,
                token_in: req.tokenIn,
                token_out: req.tokenOut,
                amount_in: req.amountIn.toString(),
                slippage_bps: req.slippageBps,
            }),
            signal: controller.signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new SwapQuoteError(res.status, `quote ${res.status}: ${body}`);
        }
        const wire = (await res.json()) as WireSwapQuote;
        return {
            venue: wire.venue,
            adapter: wire.adapter,
            route: wire.route,
            expectedOut: BigInt(wire.expected_out),
            minOut: BigInt(wire.min_out),
            gasEstimate: wire.gas_estimate,
            quotedAt: wire.quoted_at,
        };
    } finally {
        clearTimeout(timer);
    }
}

/// Quote age in seconds, computed from `quotedAt`. Frontend can pick its
/// own staleness threshold for refetch UX.
export function quoteAgeSecs(
    q: SwapQuote,
    nowSecs: number = Math.floor(Date.now() / 1000),
): number {
    return Math.max(0, nowSecs - q.quotedAt);
}
