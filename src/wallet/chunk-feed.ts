// Sliding-window pager shared by the server's two chunk feeds.
//
// Commitments (`TreeStore`) and spent nullifiers (`NullifierStore`) are served
// the same way: append-only, fixed-size chunks addressed by index, where
// `isComplete` marks every chunk but the tail. Complete chunks are
// CDN-immutable, so fetching a window of them in parallel is effectively free
// — but both consumers build positional state, so results must be folded in
// in chunk-id order regardless of the order they arrive.

import { linkAbort } from "../core/async.js";
import { getLogger } from "../log/logger.js";

/** Entries per chunk. Power of 4, so it aligns to quaternary tree levels. */
export const CHUNK_SIZE = 1024;

/**
 * Merkle depth of the deployed tree, and the default for every preset.
 *
 * Only a default: the authority is `WalletConfig.treeDepth`, which is what the
 * spend path hands the circuit. Anything deriving tree geometry must take the
 * configured depth rather than read this, or a custom preset gets a local tree
 * of one shape and proofs of another.
 */
export const TREE_DEPTH = 10;

/**
 * Hard ceiling on chunks in either feed: the tree holds `4^depth` leaves, and
 * a nullifier exists only for a spent leaf. Without it a server that always
 * answers `isComplete` would page forever.
 */
export function maxChunksFor(treeDepth: number): number {
    return Math.ceil(4 ** treeDepth / CHUNK_SIZE);
}

/** {@link maxChunksFor} at the default depth. */
export const MAX_CHUNKS = maxChunksFor(TREE_DEPTH);

/** Chunks in flight at once. */
const FETCH_WINDOW = 8;

const log = getLogger("lelantos:wallet:chunks");

export interface Chunk {
    chunkId: number;
    /** `false` marks the tail chunk — paging stops here. */
    isComplete: boolean;
}

export type PagingStop = "complete" | "maxChunks" | "aborted";

export interface PagingOpts {
    /** Defaults to {@link MAX_CHUNKS} — never unbounded. */
    maxChunks?: number | undefined;
    signal?: AbortSignal | undefined;
}

export interface PagingSummary {
    chunksFetched: number;
    stoppedBy: PagingStop;
}

/** First chunk that can still contain unseen entries, given a cursor. */
export function chunkOf(entryIndex: number): number {
    return Math.floor(entryIndex / CHUNK_SIZE);
}

/**
 * Page `fetch` from `firstChunkId` to the tail, handing each chunk to
 * `consume` in ascending chunk-id order.
 *
 * The window is abandoned once an incomplete chunk is seen, so a sync costs at
 * most `FETCH_WINDOW - 1` speculative requests beyond the tail — each cheap, an
 * empty partial chunk.
 *
 * `signal` reaches `fetchChunk`, so abandoning the window actually cancels
 * those requests rather than leaving up to eight of them running to
 * completion with their results discarded. Their rejections are still
 * swallowed: an abort or a network blip past the tail must not surface as an
 * unhandled rejection.
 */
export async function pageChunks<C extends Chunk>(
    fetchChunk: (chunkId: number, signal?: AbortSignal | undefined) => Promise<C>,
    firstChunkId: number,
    consume: (chunk: C) => void,
    /** `feed` names the source in the cap warning. */
    opts: PagingOpts & { feed: string },
): Promise<PagingSummary> {
    const maxChunks = opts.maxChunks ?? MAX_CHUNKS;
    // Highest id this call may ever request. Bounding the *fetch* rather than
    // only the consume loop is what stops the refill below from speculatively
    // issuing up to `FETCH_WINDOW - 1` requests past the cap and abandoning
    // them.
    const lastChunkId = firstChunkId + maxChunks - 1;

    // Cancels the speculative tail of the window on every exit path, including
    // a throw from `consume`. Chained to the caller's signal so either can end
    // the requests.
    const cancel = linkAbort(opts.signal);

    const inflight: Promise<C>[] = [];
    let nextFetch = firstChunkId;
    let chunksFetched = 0;

    const done = (stoppedBy: PagingStop): PagingSummary => {
        if (stoppedBy === "maxChunks") {
            log.warn("chunk sync hit the cap", { feed: opts.feed, maxChunks });
        }
        return { chunksFetched, stoppedBy };
    };

    try {
        for (;;) {
            if (opts.signal?.aborted) return done("aborted");
            if (chunksFetched >= maxChunks) return done("maxChunks");

            while (inflight.length < FETCH_WINDOW && nextFetch <= lastChunkId) {
                inflight.push(fetchChunk(nextFetch++, cancel.signal));
            }

            const next = inflight.shift();
            // Only reachable at the cap, which the loop head already catches
            // on its next pass — but the window can also be empty here when
            // `maxChunks` lands exactly on a boundary.
            if (!next) return done("maxChunks");

            const chunk = await next;
            chunksFetched++;
            consume(chunk);
            if (!chunk.isComplete) return done("complete");
        }
    } finally {
        cancel.dispose();
        cancel.abort();
        for (const pending of inflight) pending.catch(() => {});
    }
}
