// Sliding-window pager shared by the server's two chunk feeds.
//
// Commitments (`TreeStore`) and spent nullifiers (`NullifierStore`) are served
// the same way: append-only, fixed-size chunks addressed by index, where
// `isComplete` marks every chunk but the tail. Complete chunks are
// CDN-immutable, so fetching a window of them in parallel is effectively free
// — but both consumers build positional state, so results must be folded in
// in chunk-id order regardless of the order they arrive.

import { getLogger } from "../log/logger.js";

/** Entries per chunk. Power of 4, so it aligns to quaternary tree levels. */
export const CHUNK_SIZE = 1024;

/** Merkle depth of the deployed tree. Bounds both feeds. */
export const TREE_DEPTH = 10;

/**
 * Hard ceiling on chunks in either feed: the tree holds `4^depth` leaves, and
 * a nullifier exists only for a spent leaf. Without it a server that always
 * answers `isComplete` would page forever.
 */
export const MAX_CHUNKS = Math.ceil(4 ** TREE_DEPTH / CHUNK_SIZE);

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
    maxChunks?: number;
    signal?: AbortSignal;
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
 * empty partial chunk. Those in-flight requests are dropped rather than
 * awaited; their rejections are swallowed so a network blip past the tail
 * cannot surface as an unhandled rejection.
 */
export async function pageChunks<C extends Chunk>(
    fetchChunk: (chunkId: number) => Promise<C>,
    firstChunkId: number,
    consume: (chunk: C) => void,
    /** `feed` names the source in the cap warning. */
    opts: PagingOpts & { feed: string },
): Promise<PagingSummary> {
    const maxChunks = opts.maxChunks ?? MAX_CHUNKS;
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

            while (inflight.length < FETCH_WINDOW) inflight.push(fetchChunk(nextFetch++));

            // Non-null: the window was just refilled, so a request is queued.
            const chunk = await (inflight.shift() as Promise<C>);
            chunksFetched++;
            consume(chunk);
            if (!chunk.isComplete) return done("complete");
        }
    } finally {
        for (const pending of inflight) pending.catch(() => {});
    }
}
