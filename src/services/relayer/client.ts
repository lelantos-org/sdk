// Wallet-side HTTP client for the off-chain MASP relayer service.
//
// Spends (transfer/withdraw/withdrawNative): the wallet builds the transact
// SNARK, pubInputs and per-output aux. The relayer, which holds the zkey and
// tree state, adds the matching tree_update_batch SNARK and batches escrowed
// deposits under it.
//
// Deposits do not go through here. The wallet broadcasts the deposit itself;
// the relayer picks the escrow up from its `DepositEscrowed` event and
// settlement arrives on the SSE feed in `deposit-stream.ts`. Tree state comes
// from `FmdClient`.
//
// The relayer can censor but not forge: every merkle path must verify against
// on-chain `isKnownRoot` before the wallet trusts it. It must also not learn
// which note a wallet cares about, so this client exposes no per-item lookup
// and places no secret in a URL.
//
// Fees are paid privately, as an output note addressed to the relayer in the
// same spend, built from `estimateSpend`'s response by `feeOutputFromEstimate`
// in `bundle/fee.ts`. A submit with an unpaid or underpaid fee answers 402.
// This is not an x402 payment challenge, but a caller that installs
// `onPaymentRequired` on this client sees those rejections there.

import { NetworkError } from "../../errors/network.js";
import type {
    ChainsResponse,
    EstimateResponse,
    RelayerSubmitResponse,
} from "../../protocol/responses.js";
import type {
    SpendKind,
    SubmitGenericPayload,
    SubmitSwapPayload,
    SubmitTransactPayload,
} from "../../protocol/transact.js";
import type { HttpClientOptions } from "../http/client.js";
import { createJsonClient, type JsonClient } from "../http/json-client.js";
import { serializeSubmitGeneric, serializeSubmitSwap, serializeSubmitTransact } from "./codec.js";

/**
 * The estimate endpoints are read-only POSTs, so they retry on 5xx like a GET.
 * Only the submit POSTs are held to the non-idempotent policy.
 */
const READ_ONLY_POST = { idempotent: true } as const;

/**
 * HTTP client for the relayer wire protocol. A relayer service implementing the
 * protocol must match these shapes.
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
     * Carries no per-user data, so it is cacheable and identical for every
     * caller.
     */
    async getChains(): Promise<ChainsResponse> {
        return this.json.get("/chains");
    }

    /**
     * What this relayer charges to relay a spend of `kind`.
     *
     * A function of `(chainId, kind)` alone. It takes neither a payload nor a
     * proof, so an estimate for a spend the user may never send reveals no
     * nullifiers.
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
     * What the relayer charges for a `GenericCallWrapper` execution whose call leg is forwarded
     * `minGas`: the wrapper's own gas plus that floor.
     */
    async estimateGeneric(chainId: bigint | number, minGas: bigint): Promise<EstimateResponse> {
        return this.json.post(
            "/v1/generic/estimate",
            { chainId: Number(chainId), minGas: Number(minGas) },
            READ_ONLY_POST,
        );
    }

    /**
     * What the relayer charges to flush a deposit: a deposit is not relayed at
     * submit time, so this recovers the cost of the `flushBatch` the relayer
     * later proves and broadcasts.
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

    async submitGeneric(payload: SubmitGenericPayload): Promise<RelayerSubmitResponse> {
        return this.json.post("/v1/generic", serializeSubmitGeneric(payload));
    }
}

/**
 * Whether a thrown error is a relayer refusing a submission over its shielded
 * fee.
 *
 * The relayer answers 402 for this and nothing else, so the status alone is
 * decisive, but only for errors from this client: 402 is also the x402
 * payment-challenge status, which `services/http/client.ts` handles via
 * `onPaymentRequired`.
 *
 * The reason is in `err.body`, verbatim from the relayer: the asset, the amount
 * paid, the amount required, and the grace band. It is prose for display or
 * logging, not for parsing.
 *
 * The usual remedy is to re-estimate and rebuild: the quote the fee was sized
 * against is stale, and the same payload is refused again.
 */
export function isShieldedFeeRejection(err: unknown): err is NetworkError {
    return err instanceof NetworkError && err.status === PAYMENT_REQUIRED;
}

const PAYMENT_REQUIRED = 402;
