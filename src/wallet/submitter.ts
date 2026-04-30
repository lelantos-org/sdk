// Pluggable transact-bundle submitter. Default: HTTP POST to a relayer
// service (`HttpRelayerSubmitter`). Apps can swap in a multi-relayer
// submitter (race / fallback), a mock for tests, or a direct on-chain
// submitter for self-relaying flows.

import { RelayerClient, type RelayerSubmitResponse, type SubmitTransactPayload } from "../relayer";

export interface Submitter {
    submit(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse>;
}

export class HttpRelayerSubmitter implements Submitter {
    private readonly client: RelayerClient;

    constructor(baseUrl: string, fetchImpl: typeof fetch = fetch) {
        this.client = new RelayerClient(baseUrl, fetchImpl);
    }

    submit(payload: SubmitTransactPayload): Promise<RelayerSubmitResponse> {
        return this.client.submitTransact(payload);
    }
}
