// `@lelantos-org/sdk/services`: HTTP clients for the relayer (including the deposit stream), the FMD
// server and the swap quoter, and the shared HTTP client they are built on.
//
// The FMD subscription methods have no in-SDK caller: they are how a consumer obtains the `token` that
// `WalletConfig.syncStrategy = { kind: "matches" }` requires.

export { FmdClient } from "../services/fmd-server/client.js";
export {
    type CommitmentChunkEntry,
    type CommitmentChunkOut,
    type CreateSubscriptionInput,
    type FmdHead,
    type FmdMatchesPage,
    type FmdMatchOut,
    type FmdNoteOut,
    type FmdTreeState,
    GAMMA_MAX,
    GAMMA_MIN,
    type NullifierChunkOut,
    type SubscriptionOut,
} from "../services/fmd-server/wire.js";
export {
    createHttpClient,
    type HttpClient,
    type HttpClientOptions,
    type HttpRequestInit,
    PRIVACY_REQUEST_DEFAULTS,
    type StatusHook,
} from "../services/http/client.js";
export { bigintFrom, hexBytes } from "../services/http/decode.js";
export {
    createJsonClient,
    type JsonClient,
    type JsonClientOptions,
    type JsonRequestOptions,
    type QueryParams,
} from "../services/http/json-client.js";
export {
    type FetchSwapQuoteOptions,
    fetchSwapQuote,
    quoteAgeSecs,
    type SwapQuoteRequest,
    type SwapRouteQuote,
    type SwapVenue,
} from "../services/quoter/client.js";
export { isShieldedFeeRejection, RelayerClient } from "../services/relayer/client.js";
export {
    type DepositFlushed,
    DepositStream,
    type DepositStreamOptions,
    type EventSourceFactory,
    type EventSourceLike,
    type FlushWait,
    type RelayerDepositEvent,
} from "../services/relayer/deposit-stream.js";
