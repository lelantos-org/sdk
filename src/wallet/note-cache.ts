// In-memory note cache + persistence wrapper. Owns the mutable `NotesFile`
// snapshot so `Wallet` stays a thin facade. All cache mutations route
// through here, keeping store writes and in-memory state in lockstep.

import { createMutex, sleep } from "../core/async.js";
import { NetworkError } from "../core/errors.js";
import { getLogger } from "../log/logger.js";
import type { ScanHit } from "../sync/scan.js";
import {
    AWAIT_COMMITMENTS_DEFAULT_MAX_ATTEMPTS,
    AWAIT_COMMITMENTS_DEFAULT_POLL_MS,
    AWAIT_COMMITMENTS_SYNC_LIMIT,
} from "./constants.js";
import type { NoteStore, NotesFile, StoredNote } from "./note-store.js";
import { addHits, migrateNotesFile } from "./note-store.js";
import type { NoteSink } from "./sync.js";

const log = getLogger("lelantos:wallet:notes");

/**
 * Load, upgrading the schema in place if the store is behind.
 *
 * The upgrade is written back immediately. `migrateNotesFile` reissues note
 * ids, so leaving it unpersisted would hand out a different set on the next
 * load and strand any id the caller is still holding.
 */
async function loadMigrated(store: NoteStore): Promise<NotesFile> {
    const { file, migrated } = migrateNotesFile(await store.load());
    if (migrated) {
        log.info("notes file migrated", { version: file.version, notes: file.notes.length });
        await store.save(file);
    }
    return file;
}

export interface AwaitCommitmentsOpts {
    signal?: AbortSignal | undefined;
    pollMs?: number | undefined;
    maxAttempts?: number | undefined;
    /** Throw on timeout instead of returning a status. Default false. */
    throwOnTimeout?: boolean | undefined;
}

export interface AwaitCommitmentsResult {
    status: "seen" | "timeout" | "aborted";
    /** Commitments still unseen when polling stopped. */
    missing: string[];
    attempts: number;
}

/**
 * Poll until every commitment in `cms` appears in `read()`.
 *
 * Returns a status rather than void, so a lagging indexer and an aborted wait
 * are both distinguishable from success.
 *
 * Does not throw by default: this runs after a successful broadcast, so a slow
 * indexer is not a failed transaction. Pass `throwOnTimeout` when the caller
 * needs an exception.
 */
export async function awaitCommitments(
    cms: string[],
    read: () => readonly StoredNote[],
    sync: (limit: number) => Promise<unknown>,
    opts: AwaitCommitmentsOpts = {},
): Promise<AwaitCommitmentsResult> {
    if (cms.length === 0) return { status: "seen", missing: [], attempts: 0 };

    const target = cms.map((c) => c.toLowerCase());
    const pollMs = opts.pollMs ?? AWAIT_COMMITMENTS_DEFAULT_POLL_MS;
    const maxAttempts = opts.maxAttempts ?? AWAIT_COMMITMENTS_DEFAULT_MAX_ATTEMPTS;

    const missing = (): string[] => {
        const seen = new Set(read().map((n) => n.cm.toLowerCase()));
        return target.filter((c) => !seen.has(c));
    };

    const done = (
        status: AwaitCommitmentsResult["status"],
        attempts: number,
    ): AwaitCommitmentsResult => {
        const result = { status, missing: missing(), attempts };
        if (status === "timeout") {
            log.warn("commitments did not appear before the attempt cap", {
                missing: result.missing.length,
                attempts,
                waitedMs: attempts * pollMs,
            });
            if (opts.throwOnTimeout) {
                throw new NetworkError(
                    "FMD_TIMEOUT",
                    "awaitCommitments",
                    `${result.missing.length} of ${cms.length} commitments not indexed after ` +
                        `${attempts} attempts (~${Math.round((attempts * pollMs) / 1000)}s)`,
                );
            }
        }
        return result;
    };

    let attempts = 0;
    for (; attempts < maxAttempts; attempts++) {
        if (opts.signal?.aborted) return done("aborted", attempts);
        if (missing().length === 0) return done("seen", attempts);

        await sync(AWAIT_COMMITMENTS_SYNC_LIMIT);
        if (missing().length === 0) return done("seen", attempts + 1);
        if (opts.signal?.aborted) return done("aborted", attempts + 1);

        // `sleep` reports abort separately from a fully elapsed interval.
        if ((await sleep(pollMs, opts.signal)) === "aborted") {
            return done("aborted", attempts + 1);
        }
    }
    return done("timeout", attempts);
}

export class NoteCache implements NoteSink {
    private snapshot: NotesFile;
    /**
     * Serialises every write. `update`, `compact`, `checkpoint` and `refresh`
     * all read `snapshot`, then `await` a store write — so without this two
     * overlapping calls interleave and whichever saves last erases the other's
     * changes. The direction that loses `spent` flags is the dangerous one: a
     * spent note offered to the selector again.
     */
    private readonly writes = createMutex();
    /**
     * Commitment membership for {@link NoteCache.addHits}, built once and kept
     * in step with the snapshot. Rebuilding it per call made a sync
     * O(notes x pages). Dropped whenever the snapshot is replaced wholesale.
     */
    private known: Set<string> | undefined;

    constructor(
        readonly store: NoteStore,
        initial: NotesFile,
    ) {
        this.snapshot = initial;
    }

    static async open(store: NoteStore): Promise<NoteCache> {
        return new NoteCache(store, await loadMigrated(store));
    }

    get file(): NotesFile {
        return this.snapshot;
    }

    get notes(): readonly StoredNote[] {
        return this.snapshot.notes;
    }

    /**
     * Replace the in-memory snapshot with the store's current state.
     *
     * For external mutation only. A sync does not need it: `syncWallet` writes
     * through this cache via {@link NoteSink}, so the snapshot is already
     * current when it returns.
     */
    async refresh(): Promise<void> {
        await this.writes.run(async () => {
            this.snapshot = await loadMigrated(this.store);
            this.known = undefined;
        });
    }

    /** Drop notes flagged `spent: true`. Returns removed count. */
    async compact(): Promise<{ removed: number }> {
        return this.writes.run(async () => {
            const before = this.snapshot.notes.length;
            const live = this.snapshot.notes.filter((n) => !n.spent);
            const removed = before - live.length;
            if (removed === 0) return { removed: 0 };
            this.snapshot.notes = live;
            this.known = undefined;
            await this.store.save(this.snapshot);
            return { removed };
        });
    }

    // --- NoteSink ------------------------------------------------------------

    /**
     * Append scan hits to the live file. Synchronous, so it cannot interleave
     * with a queued write; persistence is deferred to {@link checkpoint} so a
     * sync still batches its store writes.
     */
    addHits(hits: ScanHit[]): { added: StoredNote[]; skipped: number } {
        this.known ??= new Set(this.snapshot.notes.map((n) => n.cm));
        return addHits(this.snapshot, hits, this.known);
    }

    /** Persist the current notes together with the sync resume `cursor`. */
    async checkpoint(cursor: number): Promise<void> {
        await this.writes.run(async () => {
            this.snapshot.cursor = cursor;
            await this.store.save(this.snapshot);
        });
    }

    /** Flip `spent` for every note whose id is in `ids`, then persist. */
    async markSpent(ids: Iterable<string>): Promise<void> {
        const set = new Set(ids);
        if (set.size === 0) return;
        await this.update((n) => setSpent(n, set.has(n.id)));
    }

    /**
     * Reserve every note whose id is in `ids` against a spend of unknown
     * outcome, then persist. See `StoredNote.pendingSpendAt`.
     */
    async markPendingSpend(ids: Iterable<string>): Promise<void> {
        const set = new Set(ids);
        if (set.size === 0) return;
        const stamp = new Date().toISOString();
        await this.update((n) => {
            if (n.spent || !set.has(n.id) || n.pendingSpendAt === stamp) return false;
            n.pendingSpendAt = stamp;
            return true;
        });
    }

    /**
     * Apply spent-set reconciliation. `spent(note)` returns true when the
     * note's nullifier was observed on-chain; `release(note)` returns true
     * when its reservation no longer stands for anything — either that same
     * observation, or expiry.
     *
     * Both in one pass, so a sync writes the notes file once and cannot leave
     * a note marked spent while it still carries a reservation.
     */
    async reconcile(rules: {
        spent: (note: StoredNote) => boolean;
        release: (note: StoredNote) => boolean;
    }): Promise<void> {
        await this.update((n) => {
            const released = n.pendingSpendAt !== undefined && rules.release(n);
            if (released) n.pendingSpendAt = undefined;
            return setSpent(n, rules.spent(n)) || released;
        });
    }

    /**
     * Apply `edit` to every note and persist once if any of them changed.
     *
     * `edit` returns whether it changed the note it was given — the single
     * rule every mutation here follows, so none of them has to remember to
     * save, and an unchanged pass never touches the store.
     */
    private async update(edit: (n: StoredNote) => boolean): Promise<void> {
        await this.writes.run(async () => {
            let mutated = false;
            for (const n of this.snapshot.notes) {
                if (edit(n)) mutated = true;
            }
            if (mutated) await this.store.save(this.snapshot);
        });
    }
}

/** Spend a note if `spent`, reporting whether that was a change. Spending is
 *  one-way: a note already spent stays spent. */
function setSpent(n: StoredNote, spent: boolean): boolean {
    if (!spent || n.spent) return false;
    n.spent = true;
    return true;
}
