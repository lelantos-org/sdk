// Wallet-side HTTP client for the off-chain MASP relayer service.
//
// Spends (transfer/withdraw/withdrawNative): the wallet builds the transact
// SNARK, pubInputs and per-output aux. The relayer assembles the matching
// tree_update_batch SNARK — it owns the multi-hundred-MB zkey and tree state —
// and batches escrowed deposits under it, up to `MAX_L_BATCH = 4` leaves.
//
// Deposits do not go through here. `wallet.deposit` broadcasts `MASP.deposit`,
// `depositAuthorized` or `NativeAdapter.depositNative` itself; the relayer
// picks the escrow up from its `DepositEscrowed` event and settlement arrives
// on the SSE feed in `deposit-stream.ts`.
//
// Tree state comes from `FmdClient`, which owns the commitment feed.
//
// The relayer can censor but not forge: every merkle path must verify against
// on-chain `isKnownRoot` before the wallet trusts it. It must also not learn
// which note a wallet cares about, so this client exposes no per-item lookup
// and places no secret in a URL; callers page the chunk feeds and filter
// locally, as with `FmdClient`.
//
// Fees are charged privately, as an output note addressed to the relayer and
// built into the same spend. Feed `estimateSpend`'s response to
// `bundle/fee.ts → feeOutputFromEstimate` and place the result in an output
// slot. A submit rejected for an unpaid or underpaid fee answers **402**; this
// is not an x402 payment challenge, but a caller that installs
// `onPaymentRequired` on this client will see those rejections there.

import { NetworkError } from "../../errors/network.js";
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
import type { HttpClientOptions } from "../http/client.js";
import { createJsonClient, type JsonClient } from "../http/json-client.js";
import { serializeSubmitSwap, serializeSubmitTransact } from "./codec.js";

/**
 * The estimate endpoints are POSTs that read: repeating one changes nothing, so
 * they retry on 5xx like a GET. Only the submit POSTs are held to the
 * non-idempotent policy.
 */
const READ_ONLY_POST = { idempotent: true } as const;

/**
 * HTTP client for the relayer wire protocol. Every relayer service implementing
 * the protocol MUST match these shapes.
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
     * Cacheable and identical for every caller: it carries no per-user data.
     */
    async getChains(): Promise<ChainsResponse> {
        return this.json.get("/chains");
    }

    /**
     * What this relayer will charge to relay a spend of `kind`.
     *
     * A function of `(chainId, kind)` alone, so it takes neither a payload nor
     * a proof; otherwise an estimate for an amount the user may never send would
     * reveal nullifiers that never reach the chain.
     *
     * The quote is advisory: it is not signed, and the relayer re-derives the
     * requirement when the spend arrives. Pay at least `RelayerFeeQuote.circuitAmount`;
     * the relayer's `graceBps` absorbs drift in between.
     */
    async estimateSpend(chainId: bigint | number, kind: SpendKind): Promise<EstimateResponse> {
        return this.json.post(
            "/v1/spend/estimate",
            { chainId: Number(chainId), kind },
            READ_ONLY_POST,
        );
    }

    async estimateSwap(chainId: bigint | number): Promise<EstimateResponse> {
        return this.json.post("/v1/swap/estimate", { chainId: Number(chainId) }, READ_ONLY_POST);
    }

    /**
     * What the relayer charges to flush a deposit.
     *
     * Priced against `flushBatch` rather than a spend: a deposit is not relayed
     * at submit time, and the relayer recovers the cost of the batch it later
     * proves and broadcasts.
     */
    async estimateDeposit(chainId: bigint | number): Promise<EstimateResponse> {
        return this.json.post("/v1/deposit/estimate", { chainId: Number(chainId) }, READ_ONLY_POST);
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
 * The relayer answers **402** for this and nothing else, so the status alone is
 * decisive, but only for errors from *this* client. 402 is also the x402
 * payment-challenge status, which `services/http/client.ts` handles separately via
 * `onPaymentRequired`; a named predicate makes the call site state which it means.
 *
 * The reason is in `err.body`, verbatim from the relayer: the asset, the amount
 * paid, the amount required, and the grace band. It is prose, not JSON: suitable
 * for display or logging, not for parsing.
 *
 * The usual remedy is to re-estimate and rebuild rather than resubmit: the quote
 * the fee was sized against is stale, and the same payload will be refused again.
 */
export function isShieldedFeeRejection(err: unknown): err is NetworkError {
    return err instanceof NetworkError && err.status === PAYMENT_REQUIRED;
}

const PAYMENT_REQUIRED = 402;
