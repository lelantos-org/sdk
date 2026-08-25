// Relayer HTTP client.
//
// The wire types live in `protocol/` — this module is the transport plus its
// codec. Exports are explicit: the serializers in `codec.ts` are internal and
// stay off the `./relayer` subpath.

export { isShieldedFeeRejection, RelayerClient } from "./client.js";
// The wire encoder for the optional `Submitter.submitDeposit` seam. No
// bundled submitter implements it — the reference relayer serves no deposit
// route — so it is exported for anyone wiring their own.
export { serializeSubmitDeposit } from "./codec.js";
export {
    type DepositFlushed,
    DepositStream,
    type DepositStreamOptions,
    type EventSourceFactory,
    type EventSourceLike,
    type FlushWait,
    type RelayerDepositEvent,
} from "./deposit-stream.js";
