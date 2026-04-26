// Wallet-side HTTP client for the off-chain MASP relayer service.
//
// Deposits: wallet POSTs `SubmitIntentPayload` to `/v1/intent`; relayer
// broadcasts `MASP.submitIntent` and later batches up to MAX_N=8 escrowed
// intents under one `flushBatch` SNARK.
// Spends (transfer/withdraw/withdrawNative): wallet builds the transact_2x2
// SNARK + pubInputs + per-output aux. Relayer assembles the matching
// tree_update_batch SNARK (owns the 249 MB zkey + tree state).
//
// Relayer can censor but not forge: every merkle path must verify against
// on-chain `isKnownRoot` before the wallet trusts it.

import { bigintFrom, mapArr, obj, str } from "../../core/decode.js";
import { createJsonClient, type HttpClientOptions, type JsonClient } from "../../core/http.js";
import type { Field } from "../../crypto/index.js";
import type {
    MerkleProofResponse,
    RelayerIntentResponse,
    RelayerSubmitResponse,
    ScannedNote,
    TreeStateResponse,
} from "../../protocol/responses.js";
import type {
    SubmitIntentPayload,
    SubmitSwapPayload,
    SubmitTransactPayload,
} from "../../protocol/transact.js";
import {
    deserializeMerkleProof,
    deserializeScannedNote,
    deserializeTreeState,
    serializeSubmitIntent,
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

    async submitIntent(payload: SubmitIntentPayload): Promise<RelayerIntentResponse> {
        const raw = await this.json.post<unknown>("/v1/intent", serializeSubmitIntent(payload));
        const r = obj(raw, "$");
        return {
            txHash: str(r.txHash, "$.txHash"),
            intentId: bigintFrom(r.intentId, "$.intentId"),
        };
    }

    async scan(fmdSecret: string): Promise<ScannedNote[]> {
        const raw = await this.json.get<unknown>(
            `/scan?fmdSecret=${encodeURIComponent(fmdSecret)}`,
        );
        const d = obj(raw, "$");
        return mapArr(d.notes, "$.notes", (n, p) => deserializeScannedNote(n, p));
    }

    async path(cm: Field): Promise<MerkleProofResponse> {
        return deserializeMerkleProof(await this.json.get<unknown>(`/path?cm=${cm.toString()}`));
    }

    async treeState(): Promise<TreeStateResponse> {
        return deserializeTreeState(await this.json.get<unknown>("/tree-state"));
    }
}
