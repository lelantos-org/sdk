// Pluggable encrypted-note feed.

import type { FmdClient, FmdNoteOut } from "../services/fmd-server/index.js";
import type { ScanInput } from "./scan.js";

export interface ListNotesOpts {
    limit?: number;
    after?: number;
}

/**
 * One page of a note feed, with two cursors because a feed can be filled out of order.
 *
 * `nextAfter` drives paging within a single sync and advances past every row just returned.
 * `resumeAfter` is the cursor safe to persist for a later session; on the `matches` feed it lags
 * while a backfill is still inserting older rows. Persisting `nextAfter` there would skip rows
 * the backfill has not inserted yet.
 *
 * On a strictly append-only feed (the full note firehose) both cursors are equal.
 */
export interface NotePage {
    inputs: ScanInput[];
    /** Cursor for the next request in this sync. Highest row id in the page. */
    nextAfter: number;
    /** Highest cursor safe to persist. Never greater than `nextAfter`. */
    resumeAfter: number;
}

/**
 * Source of encrypted notes. Merkle paths (`TreeStore`) and the spent set (`NullifierStore`) are
 * computed locally, because querying either would reveal a specific note to the server.
 */
export interface NoteSource {
    listNotes(opts?: ListNotesOpts): Promise<NotePage>;
}

// ─── internal helpers ────────────────────────────────────────────────────────

function toScanInput(n: FmdNoteOut): ScanInput {
    return {
        ciphertext: n.ciphertext,
        // Already packed by the server.
        epk: n.epk,
        cm: n.cm,
        leafIndex: n.leafIndex,
        blockNumber: n.blockNumber,
    };
}

/**
 * Highest row id in `rows`, or `after` when the page is empty, so an empty page never rewinds
 * the cursor.
 */
function maxId(rows: FmdNoteOut[], after: number): number {
    let hi = after;
    for (const r of rows) if (r.id > hi) hi = r.id;
    return hi;
}

// ─── implementations ─────────────────────────────────────────────────────────

/** Default `NoteSource` against fmd-webserver; pulls the full note firehose. */
export class FmdNoteSource implements NoteSource {
    constructor(private readonly fmd: FmdClient) {}

    async listNotes(opts: ListNotesOpts = {}): Promise<NotePage> {
        const after = opts.after ?? 0;
        const rows = await this.fmd.listNotes(opts);
        // `notes` is append-only and ordered by the cursor id, so no row can appear below the
        // highest id already returned.
        const hi = maxId(rows, after);
        return {
            inputs: rows.map(toScanInput),
            nextAfter: hi,
            resumeAfter: hi,
        };
    }
}

/**
 * `NoteSource` backed by `/v1/matches`, the server-side FMD-filtered subset. Trades anonymity
 * (the server learns the false-positive set bounded by `gamma`) for bandwidth.
 *
 * `token` is the capability registered with `FmdClient.createSubscription` and the only handle to
 * the subscription. `deriveSubscriptionToken` regenerates it from `ivk` and the epoch; the epoch
 * cannot be recovered from the server, so a caller using a non-default epoch must persist it.
 */
export class FmdMatchesNoteSource implements NoteSource {
    constructor(
        private readonly fmd: FmdClient,
        private readonly token: string,
    ) {}

    async listNotes(opts: ListNotesOpts = {}): Promise<NotePage> {
        const after = opts.after ?? 0;
        const page = await this.fmd.listMatches({ token: this.token, ...opts });
        // The persisted cursor is clamped to the backfill watermark while paging continues past
        // it. See `FmdMatchesPage`.
        const hi = maxId(page.matches, after);
        return {
            inputs: page.matches.map(toScanInput),
            nextAfter: hi,
            resumeAfter: Math.min(hi, page.backfilledThroughNoteId),
        };
    }
}
