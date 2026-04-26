// Pluggable transact-bundle submitter.

import type { HttpClientOptions } from "../core/http.js";
import type { RelayerIntentResponse, RelayerSubmitResponse } from "../protocol/responses.js";
import type {
    SubmitIntentPayload,
    SubmitSwapPayload,
    SubmitTransactPayload,
} from "../protocol/transact.js";
import { RelayerClient } from "../services/relayer/client.js";

export interface Submitter {
    /** Spend op. Relayer attaches the matching tree_update_batch SNARK + tpi. */
    submit(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse>;
    /** Deposit escrow. Falls back to `chain.submitIntent` when absent. */
    submitIntent?(payload: SubmitIntentPayload): Promise<RelayerIntentResponse>;
    /** Atomic shielded swap. Required for `Wallet.swap`. */
    submitSwap?(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse>;
}

export class HttpRelayerSubmitter implements Submitter {
    private readonly client: RelayerClient;

    constructor(baseUrl: string, opts: HttpClientOptions = {}) {
        this.client = new RelayerClient(baseUrl, opts);
    }

    submit(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse> {
        return this.client.submitTransact(payload);
    }

    submitSwap(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse> {
        return this.client.submitSwap(payload);
    }
}
