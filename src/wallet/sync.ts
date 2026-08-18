// Wallet sync: page from `NoteSource`, trial-decrypt with ivk, persist to `NoteStore`.
//
// Paging, not a single request. The feed is far larger than any one page, so
// a sync that fetched once would only ever see the first `limit` rows — and
// with a cursor that resumes across sessions, a caught-up wallet fetches
// nothing at all instead of re-scanning the same page every poll.
//
// The cursor is a source row id, persisted on `NotesFile.cursor`. Two distinct
// cursors are in play; `NotePage` explains why they differ.

import type { Field, Jubjub } from "../crypto/index.js";
import { getLogger } from "../log/logger.js";
import type { ScanHit } from "../sync/scan.js";
import type { Scanner } from "../sync/scanner.js";
import type { NoteSource } from "./note-source.js";
import type { NotesFile, StoredNote } from "./note-store.js";

const log = getLogger("lelantos:wallet:sync");

/**
 * Backstop on pages per sync. Only a server that keeps answering full pages
 * without advancing its own ids can reach this, which the cursor check below
 * already catches — this bounds the damage if some future feed does it
 * without repeating a cursor.
 */
const MAX_PAGES = 10_000;

/** Pages between checkpoint saves, so a mid-sync failure resumes near where it stopped. */
const CHECKPOINT_PAGES = 50;

/**
 * Why paging stopped.
 *
 * `exhausted` is the only healthy outcome. The other two mean the feed did not
 * behave, and are reported rather than logged-and-forgotten so a caller can
 * tell "caught up" from "gave up".
 */
export type SyncStop = "exhausted" | "cursorStalled" | "pageCap" | "aborted";

export interface SyncResult {
    fetched: number;
    hits: number;
    added: number;
    skipped: number;
    /** Pages requested. 1 on a caught-up poll that came back short. */
    pages: number;
    /** Persisted resume cursor after this sync. */
    cursor: number;
    stoppedBy: SyncStop;
}

/**
 * Where a sync writes what it finds.
 *
 * Deliberately not a `NoteStore`: a store hands back a fresh `NotesFile` on
 * every `load()`, so a sync that owned one would be mutating a second copy of
 * state the wallet already holds in `NoteCache` — and whichever of the two
 * saved last would erase the other's writes. The sink is the live file, so
 * exactly one `NotesFile` exists per wallet. `NoteCache` implements it.
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
    onProgress?: ((p: SyncProgress) => void) | undefined;
    /**
     * Stops paging at the next page boundary.
     *
     * Checkpointing is unaffected: whatever was scanned before the abort is
     * persisted, so the next sync resumes from there rather than re-scanning.
     * Without this a sync could page through `MAX_PAGES × limit` notes — ten
     * million at the defaults — with no way for the caller to stop it.
     */
    signal?: AbortSignal | undefined;
}

export interface SyncProgress {
    phase: "fetching" | "scanning" | "persisting" | "done";
    fetched: number;
    hits: number;
}

export async function syncWallet(deps: SyncDeps, opts: SyncOpts = {}): Promise<SyncResult> {
    const pageSize = opts.limit ?? 1000;

    // Where the last sync got to. Absent on a first run, and safe to lose:
    // starting over re-scans notes already stored, and `addHits` drops them.
    let after = deps.sink.file.cursor ?? 0;
    let resumeAfter = after;

    const tally = { fetched: 0, hits: 0, added: 0, skipped: 0, pages: 0 };
    /** Pages consumed since the last checkpoint. */
    let sinceSave = 0;
    /** A page produced notes; checkpoint at the end of it rather than waiting. */
    let foundNotes = false;
    let stoppedBy: SyncStop = "exhausted";

    const save = async (): Promise<void> => {
        await deps.sink.checkpoint(resumeAfter);
        sinceSave = 0;
        foundNotes = false;
    };

    const progress = (phase: SyncProgress["phase"]): void =>
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
                // A page that produced notes is worth checkpointing straight
                // away; the rest of the sync may still fail.
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
        // Persist whatever was scanned even if a page threw: the cursor and
        // any hits found so far are still valid, and dropping them turns a
        // transient network failure into a full re-scan on the next run.
        await save().catch((err) => log.warn("sync checkpoint save failed", { err }));
    }

    progress("done");
    return { ...tally, cursor: resumeAfter, stoppedBy };
}

/**
 * Whether to stop after a page, and why. `null` means keep going.
 *
 * Only an *empty* page means the feed ran out. A short page does not: servers
 * cap `limit` server-side, so against a feed that caps below `pageSize` every
 * page is short — and treating that as "exhausted" stopped after one page and
 * reported the wallet as caught up while it was still thousands of rows
 * behind. Callers trust `stoppedBy === "exhausted"` to mean synced, and
 * `awaitCommitments` polls at a small limit, so both were silently wrong.
 *
 * The cost is one extra empty request per sync. `cursorStalled` remains the
 * termination guard: a non-empty page that did not move the cursor means the
 * server is ignoring `after`, so paging is not working at all and looping
 * would never end.
 */
function stopReason(pageLength: number, advanced: boolean, pages: number): SyncStop | null {
    if (pageLength === 0) return "exhausted";
    if (!advanced) return "cursorStalled";
    if (pages >= MAX_PAGES) return "pageCap";
    return null;
}
