// Pluggable transact-bundle submitter. Default: HTTP POST to a relayer
// service (`HttpRelayerSubmitter`). Apps can swap in a multi-relayer
// submitter (race / fallback), a mock for tests, or a direct on-chain
// submitter for self-relaying flows.

import {
    RelayerClient,
    type RelayerIntentResponse,
    type RelayerSubmitResponse,
    type SubmitIntentPayload,
    type SubmitSwapPayload,
    type SubmitTransactPayload,
} from "../relayer.js";

export interface Submitter {
    /// Spend op (transfer / withdraw / withdrawNative). Relayer attaches
    /// the matching tree_update_batch SNARK + tpi from its own state.
    submit(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse>;
    /// Deposit escrow. Optional — when absent, wallet falls back to
    /// `chain.submitIntent` for direct-to-chain broadcast.
    submitIntent?(payload: SubmitIntentPayload): Promise<RelayerIntentResponse>;
    /// Atomic shielded swap. Optional — `Wallet.swap` requires this.
    submitSwap?(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse>;
}

export class HttpRelayerSubmitter implements Submitter {
    private readonly client: RelayerClient;

    constructor(baseUrl: string, fetchImpl?: typeof fetch) {
        this.client = new RelayerClient(baseUrl, fetchImpl ?? ((...args) => fetch(...args)));
    }

    submit(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse> {
        return this.client.submitTransact(payload);
    }

    submitSwap(payload: SubmitSwapPayload): Promise<RelayerSubmitResponse> {
        return this.client.submitSwap(payload);
    }
}
