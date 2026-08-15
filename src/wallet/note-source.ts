// Pluggable encrypted-note feed.

import type { MerkleProof } from "../crypto/merkle.js";
import type { FmdClient, FmdNoteOut } from "../services/fmd-server/client.js";
import type { ScanInput } from "../sync/scan.js";

export interface ListNotesOpts {
    limit?: number;
    after?: number;
}

/**
 * One page of a note feed, plus the two cursors paging needs.
 *
 * They differ because a feed can be filled out of order. `nextAfter` drives
 * the loop within a single sync and always advances past everything just
 * seen; `resumeAfter` is what may be written down and resumed from in a later
 * session, and on the `matches` feed it lags behind while a backfill is still
 * walking history upward. Persisting `nextAfter` there would step over rows
 * the backfill has not inserted yet and lose them permanently.
 *
 * For a feed that is strictly append-only — the full note firehose — the two
 * are the same value.
 */
export interface NotePage {
    inputs: ScanInput[];
    /** Cursor for the next request in this sync. Highest row id in the page. */
    nextAfter: number;
    /** Highest cursor safe to persist. Never greater than `nextAfter`. */
    resumeAfter: number;
}

/** Minimal Jubjub interface needed by note sources. */
export type JubjubPacker = { packPoint: (p: [bigint, bigint]) => Uint8Array };

/**
 * Source of encrypted notes. Merkle paths are computed locally via
 * `TreeStore`, and the spent set via `NullifierStore` — neither is a query a
 * note source answers, because both would name a specific note to the server.
 */
export interface NoteSource {
    listNotes(opts?: ListNotesOpts): Promise<NotePage>;
}

export type { MerkleProof };

// ─── internal helpers ────────────────────────────────────────────────────────

function toScanInput(J: JubjubPacker, n: FmdNoteOut): ScanInput {
    return {
        ciphertext: n.ciphertext,
        epk: J.packPoint(n.ephPub),
        cm: n.cm,
        leafIndex: n.leafIndex,
        blockNumber: n.blockNumber,
    };
}

/**
 * Highest row id in `rows`, or `after` when the page is empty.
 *
 * Falling back to the request cursor rather than 0 keeps an empty page from
 * rewinding a cursor that has already moved past those rows.
 */
function maxId(rows: FmdNoteOut[], after: number): number {
    let hi = after;
    for (const r of rows) if (r.id > hi) hi = r.id;
    return hi;
}

// ─── implementations ─────────────────────────────────────────────────────────

/** Default `NoteSource` against fmd-webserver — pulls the full note firehose. */
export class FmdNoteSource implements NoteSource {
    constructor(
        private readonly fmd: FmdClient,
        private readonly J: JubjubPacker,
    ) {}

    async listNotes(opts: ListNotesOpts = {}): Promise<NotePage> {
        const after = opts.after ?? 0;
        const rows = await this.fmd.listNotes(opts);
        // `notes` is append-only and ordered by the same id the cursor uses,
        // so nothing can ever land below the highest id already returned.
        const hi = maxId(rows, after);
        return {
            inputs: rows.map((n) => toScanInput(this.J, n)),
            nextAfter: hi,
            resumeAfter: hi,
        };
    }
}

/**
 * `NoteSource` backed by `/v1/matches`: server-side FMD-filtered subset.
 * Trades anonymity (server learns the FP set bound by `gamma`) for bandwidth.
 *
 * `token` is the capability the caller registered with
 * `FmdClient.createSubscription`. It is the only handle to the subscription.
 * `deriveSubscriptionToken` regenerates it, so at the default epoch there is
 * nothing to store — but regeneration needs `ivk` *and* the epoch, and the
 * epoch cannot be recovered from the server. A caller that has rotated must
 * persist it alongside its own config.
 */
export class FmdMatchesNoteSource implements NoteSource {
    constructor(
        private readonly fmd: FmdClient,
        private readonly J: JubjubPacker,
        private readonly token: string,
    ) {}

    async listNotes(opts: ListNotesOpts = {}): Promise<NotePage> {
        const after = opts.after ?? 0;
        const page = await this.fmd.listMatches({ token: this.token, ...opts });
        // Clamped, not floored at `after`: until the backfill watermark passes
        // this page the persisted cursor must stay put, even though paging
        // continues past it. See `FmdMatchesPage`.
        const hi = maxId(page.matches, after);
        return {
            inputs: page.matches.map((n) => toScanInput(this.J, n)),
            nextAfter: hi,
            resumeAfter: Math.min(hi, page.backfilledThroughNoteId),
        };
    }
}
