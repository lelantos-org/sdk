// Wallet sync: page from `NoteSource`, trial-decrypt with ivk, persist through `NoteSink`.
//
// Pages until the feed is exhausted. The resume cursor is a source row id persisted on
// `NotesFile.cursor`, so a caught-up wallet fetches no rows; `NotePage` explains the two cursors.

import type { Field, Jubjub } from "../crypto/index.js";
import { getLogger } from "../log/logger.js";
import type { NotesFile, StoredNote } from "../protocol/note-record.js";
import type { NoteSource } from "./note-source.js";
import type { ScanHit } from "./scan.js";
import type { Scanner } from "./scanner.js";

const log = getLogger("lelantos:wallet:sync");

/** Upper bound on pages per sync, for a non-terminating feed the cursor-stall check misses. */
const MAX_PAGES = 10_000;

/** Pages between checkpoint saves, so a mid-sync failure resumes near where it stopped. */
const CHECKPOINT_PAGES = 50;

/**
 * Why paging stopped: `exhausted` means caught up, `cursorStalled` and `pageCap` a misbehaving
 * feed, `aborted` a cancelled sync.
 */
export type SyncStop = "exhausted" | "cursorStalled" | "pageCap" | "aborted";

export interface SyncResult {
    fetched: number;
    hits: number;
    added: number;
    skipped: number;
    /** Pages requested; 1 on a caught-up poll. */
    pages: number;
    /** Persisted resume cursor after this sync. */
    cursor: number;
    stoppedBy: SyncStop;
}

/**
 * Destination for sync results, implemented by `NoteCache`.
 *
 * Exposes the live `NotesFile` rather than a `NoteStore`, whose `load()` returns a fresh copy:
 * syncing into a second copy would let one save overwrite the other's changes.
 */
export interface NoteSink {
    /** The live notes file. Read for the resume cursor; never replaced. */
    readonly file: NotesFile;
    /** Append hits to the live file in memory. Idempotent by `cm`. */
    addHits(hits: ScanHit[]): { added: StoredNote[]; skipped: number };
    /** Persist the current notes together with `cursor`. */
    checkpoint(cursor: number): Promise<void>;
}

export interface SyncDeps {
    J: Jubjub;
    ivk: Field;
    source: NoteSource;
    sink: NoteSink;
    scanner: Scanner;
}

export interface SyncOpts {
    /** Page size. Not a ceiling on notes fetched. */
    limit?: number | undefined;
    onProgress?: ((p: NotesSyncProgress) => void) | undefined;
    /**
     * Stops paging at the next page boundary. Progress scanned before the abort is checkpointed,
     * so the next sync resumes from there.
     */
    signal?: AbortSignal | undefined;
}

/** One notes-feed sync pass; the wallet reports it as `SyncProgress` `{ stream: "notes" }`. */
export interface NotesSyncProgress {
    phase: "fetching" | "scanning" | "persisting" | "done";
    fetched: number;
    hits: number;
}

export async function syncWallet(deps: SyncDeps, opts: SyncOpts = {}): Promise<SyncResult> {
    const pageSize = opts.limit ?? 1000;

    // Resume point of the last sync. Absent on a first run, and safe to lose: a re-scan yields
    // notes `addHits` already dedupes.
    let after = deps.sink.file.cursor ?? 0;
    let resumeAfter = after;

    const tally = { fetched: 0, hits: 0, added: 0, skipped: 0, pages: 0 };
    /** Pages consumed since the last checkpoint. */
    let sinceSave = 0;
    /** Set when a page added notes, forcing a checkpoint at its end, since later pages may fail. */
    let foundNotes = false;
    let stoppedBy: SyncStop = "exhausted";

    const save = async (): Promise<void> => {
        await deps.sink.checkpoint(resumeAfter);
        sinceSave = 0;
        foundNotes = false;
    };

    const progress = (phase: NotesSyncProgress["phase"]): void =>
        opts.onProgress?.({ phase, fetched: tally.fetched, hits: tally.hits });

    try {
        for (;;) {
            if (opts.signal?.aborted) {
                stoppedBy = "aborted";
                break;
            }
            progress("fetching");
            const page = await deps.source.listNotes({ limit: pageSize, after });
            tally.pages++;
            tally.fetched += page.inputs.length;

            if (page.inputs.length > 0) {
                progress("scanning");
                const pageHits = await deps.scanner.scan(deps.ivk, page.inputs);
                tally.hits += pageHits.length;

                progress("persisting");
                const { added, skipped } = deps.sink.addHits(pageHits);
                tally.added += added.length;
                tally.skipped += skipped;
                if (added.length > 0) foundNotes = true;
            }

            resumeAfter = Math.max(resumeAfter, page.resumeAfter);
            const advanced = page.nextAfter > after;
            after = Math.max(after, page.nextAfter);

            sinceSave++;
            if (foundNotes || sinceSave >= CHECKPOINT_PAGES) await save();

            const stop = stopReason(page.inputs.length, advanced, tally.pages);
            if (stop) {
                stoppedBy = stop;
                if (stop !== "exhausted") {
                    log.warn("note sync stopped early", { stoppedBy: stop, after, pageSize });
                }
                break;
            }
        }
    } finally {
        // Persist progress even if a page threw: the cursor and hits so far remain valid, so a
        // transient failure does not force a full re-scan.
        await save().catch((err) => log.warn("sync checkpoint save failed", { err }));
    }

    progress("done");
    return { ...tally, cursor: resumeAfter, stoppedBy };
}

/**
 * Whether to stop after a page, and why. `null` means continue.
 *
 * Only an empty page means exhausted: servers cap `limit`, so a short page may be followed by more
 * rows, and callers rely on `"exhausted"` meaning fully synced. A non-empty page that does not
 * advance the cursor means the server ignores `after`, and paging would never end.
 */
function stopReason(pageLength: number, advanced: boolean, pages: number): SyncStop | null {
    if (pageLength === 0) return "exhausted";
    if (!advanced) return "cursorStalled";
    if (pages >= MAX_PAGES) return "pageCap";
    return null;
}
