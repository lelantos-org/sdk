// The shapes fmd-webserver returns, as domain values. `./decode.ts` builds them
// from raw JSON.

import type { Field } from "../../crypto/index.js";

export interface FmdTreeState {
    chainId: number;
    leafCount: number;
    root: Field;
    frontier: Field[][];
}

/**
 * The two watermarks a wallet syncs against: what a client needs to decide
 * whether to make the expensive reads.
 */
export interface FmdHead {
    chainId: number;
    maxNoteId: number;
    maxNullifierSeq: number;
}

export interface FmdNoteOut {
    id: number;
    chainId: number;
    blockNumber: number;
    leafIndex: number;
    cm: Field;
    ciphertext: Uint8Array;
    /**
     * Sender's ECDH ephemeral public point, packed as `babyJub.packPoint`
     * does: 32 bytes of `y` little-endian with the high bit of the last byte
     * carrying `sign(x)`. `decryptNote` takes this form as `epk`, so it is
     * never unpacked on this path.
     */
    epk: Uint8Array;
    /**
     * The clue point `R`, packed as `epk` is. The scanner compares it byte for byte with the clue
     * it recomputes from the opened note.
     */
    clueR: Uint8Array;
}

/** Server-side FMD-filtered note. Wire field `noteId` normalised to `id`. */
export interface FmdMatchOut extends FmdNoteOut {}

/**
 * A page of matches plus the subscription's backfill watermark.
 *
 * `matches` is filled from both ends at once: the indexer's live tick inserts
 * rows for notes at the head while its backfill walks history upward. The
 * highest `id` in a page is therefore not a safe resume cursor: rows below it
 * may still be pending, and a cursor above the gap would skip them permanently.
 *
 * `backfilledThroughNoteId` is the highest note id already scanned against
 * this subscription's key; a persisted cursor must be clamped to it. Rows
 * above it are delivered anyway and re-delivered until the watermark passes
 * them; `addHits` dedupes them by `cm`.
 */
export interface FmdMatchesPage {
    matches: FmdMatchOut[];
    backfilledThroughNoteId: number;
}

/**
 * Result of `POST /v1/subscriptions`. Neither the token nor the detection key
 * is echoed: the caller derives and supplies both.
 *
 * `created` is `false` when the token already had a subscription and this
 * call re-attached to it, as when a wallet re-derives after losing local
 * state. Its backfill is already under way or complete, so matches may be
 * available immediately.
 */
export interface SubscriptionOut {
    gamma: number;
    active: boolean;
    created: boolean;
}

export interface CommitmentChunkEntry {
    leafIndex: number;
    /**
     * The tree leaf: the note commitment
     * `Poseidon(TAG_CM, asset · 2^64 + value, inner)`.
     *
     * A spend output's leaf is the `cm` the pool published in `NotePayload`.
     * A deposit's is in no event: the server computes it from the escrow's
     * asset, amount and `inner`, as the batch circuit does.
     *
     * Trusted, not re-derived by the client: a wrong value yields a wrong
     * root, so a rejected transaction, not a loss of funds.
     * `TreeStore.verifyRoot` catches it.
     */
    leafHash: Field;
}

export interface CommitmentChunkOut {
    chunkId: number;
    entries: CommitmentChunkEntry[];
    /** `false` marks the tail chunk, where the client stops paging. */
    isComplete: boolean;
}

export interface NullifierChunkOut {
    chunkId: number;
    /**
     * Ascending by insertion order.
     *
     * `bigint`, not `Field`: the server sends the low 10 bytes of each
     * nullifier, so these are truncations, not field elements. Compare against
     * a full nullifier only through `NullifierStore.has`, which truncates its
     * argument the same way.
     */
    nullifiers: bigint[];
    isComplete: boolean;
}

/**
 * γ sets the false-positive rate at `2^-γ`. The range is server-enforced; the
 * server also caps γ against the current note count so a match set keeps
 * enough decoys, and rejects a `detectionKeyHex` that is not exactly
 * `gamma * 32` bytes.
 */
export const GAMMA_MIN = 1;
// The server's declared maximum. Two lower limits bind first:
// `AuxValidation.sol` masks the on-chain clue-bits field to 0x3FFF, so bits
// 14-15 are never set, and senders pack only `FMD_DEFAULT_GAMMA` bits. The
// effective limit is `assertDetectionGamma`.
export const GAMMA_MAX = 16;

export interface CreateSubscriptionInput {
    /**
     * The γ expanded detection scalars, from `detectionKeyFor` + `detectionKeyToHex`.
     *
     * Confers the full detection capability, which cannot be scoped or
     * revoked: `h_i` is public, so `dk = x_i - h_i` recovers the root. The
     * server can then identify this recipient's incoming notes, at a 2^-γ
     * false-positive rate, for as long as the key is valid.
     */
    detectionKeyHex: string;
    gamma: number;
    /**
     * Capability token for `/v1/matches` and `DELETE /v1/subscriptions`,
     * bare 32-byte hex. Build it with `deriveSubscriptionToken` +
     * `subscriptionTokenToHex`, never from `dk` or the detection key: the
     * scalars are `x_i = dk + h_i` over a publicly computable `h_i`, so this
     * server can invert either back to `dk` and mint its own token.
     */
    tokenHex: string;
}
