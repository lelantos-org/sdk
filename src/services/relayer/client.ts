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

import { createJsonClient, type HttpClientOptions, type JsonClient } from "../../core/http.js";
import type { RelayerSubmitResponse } from "../../protocol/responses.js";
import type { SubmitSwapPayload, SubmitTransactPayload } from "../../protocol/transact.js";
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

    async submitTransact(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse> {
        return this.json.post("/v1/spend", serializeSubmitTransact(payload));
    }

    async submitSwap(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse> {
        return this.json.post("/v1/swap", serializeSubmitSwap(payload));
    }
}
