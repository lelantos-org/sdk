// Wallet-side HTTP client for the off-chain MASP relayer service.
//
// Spends (transfer/withdraw/withdrawNative): wallet builds the transact
// SNARK + pubInputs + per-output aux. Relayer assembles the matching
// tree_update_batch SNARK (owns the multi-hundred-MB zkey + tree state) and
// batches escrowed deposits, up to `MAX_L_BATCH = 8` leaves, under it.
//
// Deposits do NOT go through here in the default wiring: `Wallet.deposit`
// broadcasts `MASP.deposit` / `depositAuthorized` /
// `NativeAdapter.depositNative` itself, and the relayer picks the escrow up
// from its `DepositEscrowed` event. `submitDeposit` below is the wire format
// for a relayer that chooses to broadcast on the wallet's behalf; the
// reference relayer serves no `/v1/deposit` route today, so calling it
// against that deployment 404s.
//
// Relayer can censor but not forge: every merkle path must verify against
// on-chain `isKnownRoot` before the wallet trusts it.
//
// It must also not learn which note a wallet cares about: this client exposes
// no per-item lookup and places no secret in a URL. Callers page the chunk
// feeds and filter locally, as with `FmdClient`.

import { hex32 } from "../../core/brand.js";
import { bigintFrom, obj, str } from "../../core/decode.js";
import { createJsonClient, type HttpClientOptions, type JsonClient } from "../../core/http.js";
import type {
    RelayerDepositResponse,
    RelayerSubmitResponse,
    TreeStateResponse,
} from "../../protocol/responses.js";
import type {
    SubmitDepositPayload,
    SubmitSwapPayload,
    SubmitTransactPayload,
} from "../../protocol/transact.js";
import {
    deserializeTreeState,
    serializeSubmitDeposit,
    serializeSubmitSwap,
    serializeSubmitTransact,
} from "./codec.js";

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

    /**
     * POST the full `PubInputs.DepositRequest` — `cvDep` and `rcv` included,
     * since the relayer rebuilds the on-chain struct from it — plus the
     * Permit2 witness signature.
     *
     * Optional relayer capability: see the note at the top of this file.
     */
    async submitDeposit(payload: SubmitDepositPayload): Promise<RelayerDepositResponse> {
        const raw = await this.json.post<unknown>("/v1/deposit", serializeSubmitDeposit(payload));
        const r = obj(raw, "$");
        return {
            txHash: hex32(str(r.txHash, "$.txHash")),
            depositId: bigintFrom(r.depositId, "$.depositId"),
        };
    }

    async treeState(): Promise<TreeStateResponse> {
        return deserializeTreeState(await this.json.get<unknown>("/tree-state"));
    }
}
