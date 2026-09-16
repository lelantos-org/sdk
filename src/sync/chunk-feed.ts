// Sliding-window pager shared by the server's two chunk feeds.
//
// Commitments (`TreeStore`) and spent nullifiers (`NullifierStore`) are served as
// append-only, fixed-size chunks addressed by index, where `isComplete` marks every
// chunk except the tail. Complete chunks are CDN-immutable, so a window is fetched
// in parallel; both consumers build positional state, so results are consumed in
// chunk-id order regardless of arrival order.

import { linkAbort } from "../core/async.js";
import { getLogger } from "../log/logger.js";

/** Entries per chunk. Power of 4, so it aligns to quaternary tree levels. */
export const CHUNK_SIZE = 1024;

/**
 * Merkle depth of the deployed tree, and the default for every preset.
 *
 * The authoritative value is `WalletConfig.treeDepth`, which the spend path
 * passes to the circuit. Code deriving tree geometry must use the configured
 * depth, or a custom preset builds a local tree that does not match its proofs.
 */
export const TREE_DEPTH = 10;

/**
 * Upper bound on chunks in either feed: the tree holds `4^depth` leaves and a
 * nullifier exists only for a spent leaf. Prevents unbounded paging against a
 * server that always reports `isComplete`.
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
    /** `false` marks the tail chunk, where paging stops. */
    isComplete: boolean;
}

export type PagingStop = "complete" | "maxChunks" | "aborted";

export interface PagingOpts {
    /** Defaults to {@link MAX_CHUNKS}; paging is always bounded. */
    maxChunks?: number | undefined;
    signal?: AbortSignal | undefined;
}

interface PagingSummary {
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
 * The window is abandoned once an incomplete chunk is seen, so a sync issues at
 * most `FETCH_WINDOW - 1` speculative requests beyond the tail, each for an
 * empty partial chunk.
 *
 * `signal` is passed to `fetchChunk`, so abandoning the window cancels those
 * requests. Their rejections are swallowed so that an abort or network error
 * past the tail does not surface as an unhandled rejection.
 */
export async function pageChunks<C extends Chunk>(
    fetchChunk: (chunkId: number, signal?: AbortSignal | undefined) => Promise<C>,
    firstChunkId: number,
    consume: (chunk: C) => void,
    /** `feed` names the source in the cap warning. */
    opts: PagingOpts & { feed: string },
): Promise<PagingSummary> {
    const maxChunks = opts.maxChunks ?? MAX_CHUNKS;
    // Highest id this call may request. Bounding the fetch, not only the consume
    // loop, prevents the refill below from issuing speculative requests past the
    // cap.
    const lastChunkId = firstChunkId + maxChunks - 1;

    // Cancels the speculative tail of the window on every exit path, including a
    // throw from `consume`. Linked to the caller's signal so either can abort.
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
                const pending = fetchChunk(nextFetch++, cancel.signal);
                // Observed at once: a speculative chunk can reject while an earlier one is still
                // awaited, which would otherwise be reported as an unhandled rejection before the
                // `finally` below attaches its handler. Awaiting `pending` still rejects.
                pending.catch(() => {});
                inflight.push(pending);
            }

            const next = inflight.shift();
            // Empty only at the cap, e.g. when `maxChunks` lands exactly on a
            // window boundary.
            if (!next) return done("maxChunks");

            const chunk = await next;
            chunksFetched++;
            consume(chunk);
            if (!chunk.isComplete) return done("complete");
        }
    } finally {
        // Detach and abort the speculative tail; every `pending` already has a handler attached.
        cancel[Symbol.dispose]();
    }
}
