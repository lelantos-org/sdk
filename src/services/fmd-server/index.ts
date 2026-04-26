// fmd-webserver HTTP client.
//
// The subscription methods are the only way a consumer obtains the
// `subscriptionId` that `WalletConfig.syncStrategy = { kind: "matches" }`
// requires, so they are public despite having no in-SDK caller.

export {
    type CommitmentChunkEntry,
    type CommitmentChunkOut,
    type CreateSubscriptionInput,
    FmdClient,
    type FmdMatchOut,
    type FmdNoteOut,
    type FmdPath,
    type FmdTreeState,
    type SubscriptionOut,
} from "./client.js";
