// Wallet-side HTTP client for the off-chain MASP relayer service.
//
// Spends (transfer/withdraw/withdrawNative): wallet builds the transact
// SNARK + pubInputs + per-output aux. Relayer assembles the matching
// tree_update_batch SNARK (owns the multi-hundred-MB zkey + tree state) and
// batches escrowed deposits, up to `MAX_L_BATCH = 4` leaves, under it.
//
// Deposits do not go through here: `Wallet.deposit` broadcasts
// `MASP.deposit` / `depositAuthorized` / `NativeAdapter.depositNative`
// itself, and the relayer picks the escrow up from its `DepositEscrowed`
// event. Settlement arrives on the SSE feed in `deposit-stream.ts`.
//
// Tree state comes from `FmdClient`, which owns the commitment feed.
//
// Relayer can censor but not forge: every merkle path must verify against
// on-chain `isKnownRoot` before the wallet trusts it.
//
// It must also not learn which note a wallet cares about: this client exposes
// no per-item lookup and places no secret in a URL. Callers page the chunk
// feeds and filter locally, as with `FmdClient`.
//
// A relayer may charge for the service, and charges privately: the fee is an
// output note addressed to the relayer, built into the same spend. Feed
// `estimateSpend`'s response to `bundle/fee.ts → feeOutputFromEstimate` and put
// the result in an output slot. A submit rejected for an unpaid or underpaid
// fee answers **402** — note that this is not an x402 payment challenge, and a
// caller that installs `onPaymentRequired` on this client will see those
// rejections there.

import { NetworkError } from "../../core/errors.js";
import type { HttpClientOptions } from "../../core/http.js";
import { createJsonClient, type JsonClient } from "../../core/json-client.js";
import type {
    ChainsResponse,
    EstimateResponse,
    RelayerSubmitResponse,
} from "../../protocol/responses.js";
import type {
    SpendKind,
    SubmitSwapPayload,
    SubmitTransactPayload,
} from "../../protocol/transact.js";
import { serializeSubmitSwap, serializeSubmitTransact } from "./codec.js";

/**
 * HTTP client for the relayer wire protocol. The wire format here is the
 * SDK's expectation — every relayer service speaking it MUST match these shapes.
 */
export class RelayerClient {
    private readonly json: JsonClient;

    constructor(baseUrl: string, opts: HttpClientOptions = {}) {
        this.json = createJsonClient(
            baseUrl,
            { timeout: "RELAYER_TIMEOUT", failure: "RELAYER_FAILED" },
            opts,
        );
    }

    /**
     * The chain registry a client boots from: ids, contract addresses, the
     * asset table, and the shielded fee terms where a relayer charges one.
     *
     * Cacheable and identical for every caller — it carries nothing per-user,
     * which is why it is a GET with no parameters.
     */
    async getChains(): Promise<ChainsResponse> {
        return this.json.get("/chains");
    }

    /**
     * What this relayer will charge to relay a spend of `kind`.
     *
     * A function of `(chainId, kind)` alone, so it takes neither a payload nor
     * a proof — an estimate fired for an amount the user may never send would
     * otherwise name nullifiers that never reach the chain.
     *
     * The quote is advisory: it is not signed, and the relayer re-derives the
     * requirement when the spend arrives. Pay at least
     * {@link FeeQuote.circuitAmount}; the relayer's `graceBps` is what absorbs
     * the drift in between.
     */
    async estimateSpend(chainId: bigint | number, kind: SpendKind): Promise<EstimateResponse> {
        return this.json.post("/v1/spend/estimate", { chainId: Number(chainId), kind });
    }

    async estimateSwap(chainId: bigint | number): Promise<EstimateResponse> {
        return this.json.post("/v1/swap/estimate", { chainId: Number(chainId) });
    }

    async submitTransact(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse> {
        return this.json.post("/v1/spend", serializeSubmitTransact(payload));
    }

    async submitSwap(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse> {
        return this.json.post("/v1/swap", serializeSubmitSwap(payload));
    }
}

/**
 * Whether a thrown error is a relayer refusing a submission over its shielded
 * fee.
 *
 * The relayer answers **402** for this and for nothing else, so the status
 * alone is decisive — but only for errors from *this* client. 402 is also the
 * x402 payment-challenge status, which `core/http.ts` handles separately via
 * `onPaymentRequired`; the point of a named predicate is that a call site says
 * which of the two it means.
 *
 * The reason is in `err.body`, verbatim from the relayer: which asset, what it
 * paid, what was required, and the grace band. It is prose, not JSON — enough
 * to show a user or put in a log, not something to parse for a number.
 *
 * The useful reaction is almost always to re-estimate and rebuild rather than
 * to resubmit: the quote a fee was sized against has gone stale, and the same
 * payload will be refused again.
 */
export function isShieldedFeeRejection(err: unknown): err is NetworkError {
    return err instanceof NetworkError && err.status === PAYMENT_REQUIRED;
}

const PAYMENT_REQUIRED = 402;
