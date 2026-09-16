// The shapes fmd-webserver returns, as domain values.
//
// Types only: no decoding, no HTTP. `./decode.ts` builds these from raw JSON
// and `./client.ts` fetches them, so a module that only names a response (a
// store, a test fixture) imports nothing else.

import type { Field } from "../../crypto/index.js";

export interface FmdTreeState {
    chainId: number;
    leafCount: number;
    root: Field;
    frontier: Field[][];
}

/**
 * The two watermarks a wallet syncs against.
 *
 * Polled more often than any other route, so it carries only what a client
 * needs to decide whether to make the expensive reads.
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
     * Sender's ECDH ephemeral public point, already packed by the server the
     * way `babyJub.packPoint` packs one: 32 bytes of `y` little-endian with
     * the high bit of the last byte carrying `sign(x)`.
     *
     * Bytes, not a `Point`: `decryptNote` takes this form as `epk`, so nothing
     * on this path unpacks it.
     */
    epk: Uint8Array;
}

/** Server-side FMD-filtered note. Wire field `noteId` normalised to `id`. */
export interface FmdMatchOut extends FmdNoteOut {}

/**
 * A page of matches plus the subscription's backfill watermark.
 *
 * `matches` is filled from both ends at once: the indexer's live tick inserts
 * rows for notes at the head while its backfill walks history upward. The
 * highest `id` in a page is therefore NOT a safe resume cursor: rows below it
 * may still be pending, and a cursor placed above the gap would skip them
 * permanently.
 *
 * `backfilledThroughNoteId` is the highest note id already scanned against
 * this subscription's key; a persisted cursor must be clamped to it. Rows
 * above it are still delivered, so a new note never waits for a backfill; they
 * are re-delivered until the watermark passes them, and `addHits` dedupes them
 * by `cm`.
 */
export interface FmdMatchesPage {
    matches: FmdMatchOut[];
    backfilledThroughNoteId: number;
}

/**
 * Result of `POST /v1/subscriptions`. Neither the token nor the detection key
 * is echoed: the caller derives and supplies both.
 *
 * `created` is `false` when the token already had a subscription behind it
 * and this call re-attached to it, as when a wallet re-derives after losing
 * local state. That subscription's backfill is already under way or complete,
 * so matches may be available immediately.
 */
export interface SubscriptionOut {
    gamma: number;
    active: boolean;
    created: boolean;
}

export interface CommitmentChunkEntry {
    leafIndex: number;
    /**
     * `Poseidon(TAG_LEAF, cm, cvDep.x, cvDep.y)`, computed server-side.
     *
     * Sending the hash rather than `cm` and the `cvDep` point is one field
     * element instead of three: it avoids ~1.05M pure-JS Poseidon-4 calls over
     * a full tree, the largest single term in a cold sync, and cuts this feed
     * roughly threefold on the wire.
     *
     * The client does not derive leaves from primary data, so a wrong value
     * here yields a wrong root: a rejected transaction, not a loss of funds.
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
     * nullifier, so these are truncations rather than field elements and must
     * not be fed anywhere a real nullifier is expected. Compare against one
     * only through `NullifierStore.has`, which truncates its argument the same
     * way.
     */
    nullifiers: bigint[];
    isComplete: boolean;
}

/**
 * γ sets the false-positive rate at `2^-γ`. Server-enforced range; it
 * additionally caps γ against the current note count so a match set always
 * keeps enough decoys, and rejects a `detectionKeyHex` that is not exactly
 * `gamma * 32` bytes.
 */
export const GAMMA_MIN = 1;
// Mirrors the server's declared range. Two lower limits bind first:
// `AuxValidation.sol` masks the on-chain clue-bits field to 0x3FFF, so bits
// 14-15 are never set, and senders pack only `FMD_DEFAULT_GAMMA` bits. The
// effective limit is `assertDetectionGamma`.
export const GAMMA_MAX = 16;

export interface CreateSubscriptionInput {
    /**
     * The γ expanded detection scalars, from `detectionKeyFor` +
     * `detectionKeyToHex`.
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
