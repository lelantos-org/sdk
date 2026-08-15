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
import type { Scanner } from "../sync/scanner.js";
import type { NoteSource } from "./note-source.js";
import type { NoteStore } from "./note-store.js";
import { addHits } from "./note-store.js";

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
export type SyncStop = "exhausted" | "cursorStalled" | "pageCap";

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

export interface SyncDeps {
    J: Jubjub;
    ivk: Field;
    source: NoteSource;
    store: NoteStore;
    scanner: Scanner;
}

export interface SyncProgress {
    phase: "fetching" | "scanning" | "persisting" | "done";
    fetched: number;
    hits: number;
}

export async function syncWallet(
    deps: SyncDeps,
    opts: { limit?: number; onProgress?: (p: SyncProgress) => void } = {},
): Promise<SyncResult> {
    const pageSize = opts.limit ?? 1000;
    const file = await deps.store.load();

    // Where the last sync got to. Absent on a first run, and safe to lose:
    // starting over re-scans notes already stored, and `addHits` drops them.
    let after = file.cursor ?? 0;
    let resumeAfter = after;

    const tally = { fetched: 0, hits: 0, added: 0, skipped: 0, pages: 0 };
    /** Pages consumed since the last checkpoint. */
    let sinceSave = 0;
    /** A page produced notes; checkpoint at the end of it rather than waiting. */
    let foundNotes = false;
    let stoppedBy: SyncStop = "exhausted";

    const save = async (): Promise<void> => {
        file.cursor = resumeAfter;
        await deps.store.save(file);
        sinceSave = 0;
        foundNotes = false;
    };

    const progress = (phase: SyncProgress["phase"]): void =>
        opts.onProgress?.({ phase, fetched: tally.fetched, hits: tally.hits });

    try {
        for (;;) {
            progress("fetching");
            const page = await deps.source.listNotes({ limit: pageSize, after });
            tally.pages++;
            tally.fetched += page.inputs.length;

            if (page.inputs.length > 0) {
                progress("scanning");
                const pageHits = await deps.scanner.scan(deps.ivk, page.inputs);
                tally.hits += pageHits.length;

                progress("persisting");
                const { added, skipped } = addHits(file, pageHits);
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

            const stop = stopReason(page.inputs.length, pageSize, advanced, tally.pages);
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
 * A short page is the feed running out — the ordinary exit. A *full* page that
 * did not move the cursor would otherwise loop forever; the only way to reach
 * it is a server ignoring `after`, which means paging is not working at all.
 */
function stopReason(
    pageLength: number,
    pageSize: number,
    advanced: boolean,
    pages: number,
): SyncStop | null {
    if (pageLength < pageSize) return "exhausted";
    if (!advanced) return "cursorStalled";
    if (pages >= MAX_PAGES) return "pageCap";
    return null;
}
