// `@lelantos-org/sdk/internal`: UNSTABLE. No semver guarantee.
//
// Circuit internals, the stored-note codec, wallet plumbing (`walletInternals`), sync engine pieces
// and test hooks. These change with the circuit, the stored-note encoding or the wallet's internal
// structure, including in patch releases. Pin `@lelantos-org/circuits` when relying on them.

export {
    coeffs,
    type FlattenInput,
    fiatShamirZ,
    flatten,
    hornerEval,
} from "../circuit/compression.js";
export {
    type BuildOpts,
    type CircomCoeffInputs,
    type CircomPublicInputs,
    type CircomTransactInput,
    circuitSignals,
    type TransactBinding,
    type TransactWitnessBundle,
    toCircomInput,
} from "../circuit/input.js";
export {
    type DummyBlinders,
    dummyInputAt,
    type SpendableCachedNote,
    toSpentNoteFromPath,
} from "../circuit/spent-note.js";
export {
    type Mutex,
    type RetryPolicy,
    retry,
    type SleepOutcome,
    sleep,
    withTimeout,
} from "../core/async.js";
export { safeCall } from "../core/callbacks.js";
export { cacheKeyStride } from "../crypto/merkle.js";
export { assertNever, attachContext } from "../errors/base.js";
export { envArtifactsDir, envProverThreads } from "../log/env.js";
export { getLogger, type Logger } from "../log/logger.js";
export { timed, timedSync } from "../log/timed.js";
export { decodeNotePayload, encodeNotePayload, type NotePayload } from "../notes/codec.js";
export { decodeStoredNote } from "../protocol/note-record.js";
export { __resetArtifactCacheForTest } from "../prover/artifact-bytes.js";
export { prove, verify } from "../prover/snarkjs.js";
export { arrN, tuple2 } from "../services/http/decode.js";
export { MAX_CHUNKS, maxChunksFor } from "../sync/chunk-feed.js";
export {
    type NoteSink,
    type NotesSyncProgress,
    type SyncDeps,
    type SyncOpts,
    type SyncResult,
    type SyncStop,
    syncWallet,
} from "../sync/notes-sync.js";
export {
    decodeHit,
    decodeInput,
    encodeHit,
    encodeInput,
    type ScannerMethods,
    type ScanParams,
    transferablesOf,
    type WireScanHit,
    type WireScanInput,
    type WireWasmConfig,
} from "../sync/worker/protocol.js";
export { classifyRef, matchRef, type RefKind } from "../wallet/assets/asset-ref.js";
export { AssetRegistry, type AssetRegistrySource } from "../wallet/assets/registry.js";
export type { NoteLeases } from "../wallet/notes/leases.js";
export {
    type AwaitCommitmentsOpts,
    awaitCommitments,
    NoteCache,
} from "../wallet/notes/note-cache.js";
export { addHits } from "../wallet/notes/note-store.js";
export { NullifierMemo, type SyncContext } from "../wallet/notes/sync-ops.js";
export type { ConsolidateHost } from "../wallet/ops/consolidate.js";
export type { RedenominateHost } from "../wallet/ops/redenominate.js";
export {
    type ReadOnlyWalletInternals,
    type WalletInternals,
    walletInternals,
} from "../wallet/surface/internals.js";
