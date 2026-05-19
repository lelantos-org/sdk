// Pluggable transact-bundle submitter.

import {
    RelayerClient,
    type RelayerIntentResponse,
    type RelayerSubmitResponse,
    type SubmitIntentPayload,
    type SubmitSwapPayload,
    type SubmitTransactPayload,
} from "../relayer/client.js";
import type { HttpClientOptions } from "./http.js";

export interface Submitter {
    /// Spend op. Relayer attaches the matching tree_update_batch SNARK + tpi.
    submit(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse>;
    /// Deposit escrow. Falls back to `chain.submitIntent` when absent.
    submitIntent?(payload: SubmitIntentPayload): Promise<RelayerIntentResponse>;
    /// Atomic shielded swap. Required for `Wallet.swap`.
    submitSwap?(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse>;
}

export class HttpRelayerSubmitter implements Submitter {
    private readonly client: RelayerClient;

    constructor(baseUrl: string, opts?: HttpClientOptions | typeof fetch) {
        // Back-compat: `opts` may be a raw `fetch` impl. Otherwise it's the
        // full options bag (timeouts, retries, 402 hook, custom fetch).
        const httpOpts: HttpClientOptions =
            typeof opts === "function" ? { fetchImpl: opts } : (opts ?? {});
        this.client = new RelayerClient(baseUrl, httpOpts);
    }

    submit(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse> {
        return this.client.submitTransact(payload);
    }

    submitSwap(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse> {
        return this.client.submitSwap(payload);
    }
}
