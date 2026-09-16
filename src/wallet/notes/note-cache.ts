// In-memory note cache and persistence wrapper. Owns the mutable `NotesFile` snapshot; all
// mutations route through here so store writes and in-memory state stay consistent.

import { createMutex, sleep } from "../../core/async.js";
import { WalletConfigError } from "../../errors/config.js";
import { NetworkError } from "../../errors/network.js";
import { getLogger } from "../../log/logger.js";
import type { NoteSink } from "../../sync/notes-sync.js";
import type { ScanHit } from "../../sync/scan.js";
import {
    AWAIT_COMMITMENTS_DEFAULT_POLL_MS,
    AWAIT_COMMITMENTS_DEFAULT_TIMEOUT_MS,
} from "../constants.js";
import type { NoteStore, NotesFile, StoredNote } from "./note-store.js";
import { addHits, NOTES_FILE_VERSION } from "./note-store.js";

const log = getLogger("lelantos:wallet:notes");

/**
 * Load the notes file, refusing any schema other than {@link NOTES_FILE_VERSION}.
 *
 * @throws {WalletConfigError} when the store holds another schema version.
 */
async function loadChecked(store: NoteStore): Promise<NotesFile> {
    const file = await store.load();
    if (file.version !== NOTES_FILE_VERSION) {
        throw new WalletConfigError(
            `notes store holds schema v${String(file.version)}; this SDK reads ` +
                `v${NOTES_FILE_VERSION} only. Clear the notes store and sync again`,
        );
    }
    return file;
}

export interface AwaitCommitmentsOpts {
    signal?: AbortSignal | undefined;
    /** Delay between syncs. Default 2 000 ms. */
    pollMs?: number | undefined;
    /** Give up after this long. Default 120 000 ms. */
    timeoutMs?: number | undefined;
    /**
     * Give up after this many syncs, whichever of this and `timeoutMs` comes first. Unbounded by
     * default. Internal callers that poll on a fixed budget use it.
     */
    maxAttempts?: number | undefined;
    /** Feed page size for each sync. Default: the sync's own. */
    pageSize?: number | undefined;
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
 * Returns a status so a lagging indexer or an aborted wait is distinguishable from success.
 * Does not throw by default because it runs after a successful broadcast, where a slow indexer
 * is not a failed transaction; set `throwOnTimeout` to throw instead.
 *
 * `sync` receives the page size to use, `undefined` for the sync's default.
 */
export async function awaitCommitments(
    cms: readonly string[],
    read: () => readonly StoredNote[],
    sync: (pageSize: number | undefined) => Promise<unknown>,
    opts: AwaitCommitmentsOpts = {},
): Promise<AwaitCommitmentsResult> {
    if (cms.length === 0) return { status: "seen", missing: [], attempts: 0 };

    const target = cms.map((c) => c.toLowerCase());
    const pollMs = opts.pollMs ?? AWAIT_COMMITMENTS_DEFAULT_POLL_MS;
    const timeoutMs = opts.timeoutMs ?? AWAIT_COMMITMENTS_DEFAULT_TIMEOUT_MS;
    const maxAttempts = opts.maxAttempts ?? Number.POSITIVE_INFINITY;
    const started = Date.now();

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
            const waitedMs = Date.now() - started;
            log.warn("commitments did not appear before the deadline", {
                missing: result.missing.length,
                attempts,
                waitedMs,
            });
            if (opts.throwOnTimeout) {
                throw new NetworkError(
                    "FMD_TIMEOUT",
                    "awaitCommitments",
                    `${result.missing.length} of ${cms.length} commitments not indexed after ` +
                        `${attempts} syncs (~${Math.round(waitedMs / 1000)}s)`,
                );
            }
        }
        return result;
    };

    let attempts = 0;
    for (;;) {
        if (opts.signal?.aborted) return done("aborted", attempts);
        if (missing().length === 0) return done("seen", attempts);
        if (attempts >= maxAttempts || Date.now() - started >= timeoutMs) {
            return done("timeout", attempts);
        }

        await sync(opts.pageSize);
        attempts++;
        if (missing().length === 0) return done("seen", attempts);
        if (opts.signal?.aborted) return done("aborted", attempts);
        const left = timeoutMs - (Date.now() - started);
        if (attempts >= maxAttempts || left <= 0) return done("timeout", attempts);

        // `sleep` reports abort separately from a fully elapsed interval.
        if ((await sleep(Math.min(pollMs, left), opts.signal)) === "aborted") {
            return done("aborted", attempts);
        }
    }
}

export class NoteCache implements NoteSink {
    private snapshot: NotesFile;
    /**
     * Serialises every write. `update`, `compact`, `checkpoint` and `refresh` read `snapshot` and
     * then await a store write, so overlapping calls would otherwise overwrite each other's
     * changes. Losing `spent` flags would offer a spent note to the selector again.
     */
    private readonly writes = createMutex();
    /**
     * Commitment membership for {@link NoteCache.addHits}, kept in step with the snapshot to
     * avoid an O(notes x pages) rebuild per call. Cleared when the snapshot is replaced.
     */
    private known: Set<string> | undefined;
    /** Called after each committed change to the note set; see {@link NoteCache.onChange}. */
    private changed: (() => void) | undefined;

    constructor(
        readonly store: NoteStore,
        initial: NotesFile,
    ) {
        this.snapshot = initial;
    }

    /** @throws {WalletConfigError} when the store holds another notes-file schema version. */
    static async open(store: NoteStore): Promise<NoteCache> {
        return new NoteCache(store, await loadChecked(store));
    }

    get file(): NotesFile {
        return this.snapshot;
    }

    /**
     * Register the one listener told after a change to the note set commits: notes added, spent,
     * reserved, released, compacted or reloaded. A cursor-only checkpoint is not a change. A
     * throwing listener is swallowed. Replaces any previous listener.
     */
    onChange(listener: (() => void) | undefined): void {
        this.changed = listener;
    }

    private notify(): void {
        try {
            this.changed?.();
        } catch (err) {
            log.warn("note change listener threw; ignored", { err });
        }
    }

    get notes(): readonly StoredNote[] {
        return this.snapshot.notes;
    }

    /**
     * Replace the in-memory snapshot with the store's current state.
     *
     * Needed only after external mutation of the store. `syncWallet` writes through this cache via
     * {@link NoteSink}, so the snapshot is current after a sync.
     *
     * @throws {WalletConfigError} when the store holds another notes-file schema version.
     */
    async refresh(): Promise<void> {
        await this.writes.run(async () => {
            this.snapshot = await loadChecked(this.store);
            this.known = undefined;
        });
        this.notify();
    }

    /** Drop notes flagged `spent: true`. Returns removed count. */
    async compact(): Promise<{ removed: number }> {
        const out = await this.writes.run(async () => {
            const before = this.snapshot.notes.length;
            const live = this.snapshot.notes.filter((n) => !n.spent);
            const removed = before - live.length;
            if (removed === 0) return { removed: 0 };
            this.snapshot.notes = live;
            this.known = undefined;
            await this.store.save(this.snapshot);
            return { removed };
        });
        if (out.removed > 0) this.notify();
        return out;
    }

    // --- NoteSink ------------------------------------------------------------

    /**
     * Append scan hits to the live file. Synchronous, so it cannot interleave with a queued write;
     * persistence is deferred to {@link checkpoint} so a sync batches its store writes.
     */
    addHits(hits: ScanHit[]): { added: StoredNote[]; skipped: number } {
        this.known ??= new Set(this.snapshot.notes.map((n) => n.cm));
        const out = addHits(this.snapshot, hits, this.known);
        if (out.added.length > 0) this.notify();
        return out;
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
     * Apply spent-set reconciliation. `spent(note)` returns true when the note's nullifier is
     * observed on-chain; `release(note)` returns true when its reservation should be cleared
     * (on that observation or on expiry).
     *
     * Both rules run in one pass, so a sync writes the notes file once and never leaves a spent
     * note carrying a reservation.
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
     * Apply `edit` to every note and persist once if any changed. `edit` returns whether it
     * changed the given note; a pass with no changes does not write to the store.
     */
    private async update(edit: (n: StoredNote) => boolean): Promise<void> {
        const mutated = await this.writes.run(async () => {
            let mutated = false;
            for (const n of this.snapshot.notes) {
                if (edit(n)) mutated = true;
            }
            if (mutated) await this.store.save(this.snapshot);
            return mutated;
        });
        if (mutated) this.notify();
    }
}

/** Mark a note spent if `spent`, returning whether it changed. Spending is one-way. */
function setSpent(n: StoredNote, spent: boolean): boolean {
    if (!spent || n.spent) return false;
    n.spent = true;
    return true;
}
