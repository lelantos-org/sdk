// In-memory note cache + persistence wrapper. Owns the mutable `NotesFile`
// snapshot so `Wallet` stays a thin facade. All cache mutations route
// through here, keeping store writes and in-memory state in lockstep.

import { sleep } from "../core/async.js";
import { NetworkError } from "../core/errors.js";
import { getLogger } from "../log/logger.js";
import {
    AWAIT_COMMITMENTS_DEFAULT_MAX_ATTEMPTS,
    AWAIT_COMMITMENTS_DEFAULT_POLL_MS,
    AWAIT_COMMITMENTS_SYNC_LIMIT,
} from "./constants.js";
import type { NoteStore, NotesFile, StoredNote } from "./note-store.js";

const log = getLogger("lelantos:wallet:notes");

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

export class NoteCache {
    private snapshot: NotesFile;
    constructor(
        readonly store: NoteStore,
        initial: NotesFile,
    ) {
        this.snapshot = initial;
    }

    static async open(store: NoteStore): Promise<NoteCache> {
        return new NoteCache(store, await store.load());
    }

    get file(): NotesFile {
        return this.snapshot;
    }

    get notes(): readonly StoredNote[] {
        return this.snapshot.notes;
    }

    /** Replace the in-memory snapshot with the store's current state. */
    async refresh(): Promise<void> {
        this.snapshot = await this.store.load();
    }

    /** Drop notes flagged `spent: true`. Returns removed count. */
    async compact(): Promise<{ removed: number }> {
        const before = this.snapshot.notes.length;
        const live = this.snapshot.notes.filter((n) => !n.spent);
        const removed = before - live.length;
        if (removed === 0) return { removed: 0 };
        this.snapshot.notes = live;
        await this.store.save(this.snapshot);
        return { removed };
    }

    /** Flip `spent` for every note whose id is in `ids`, then persist. */
    async markSpent(ids: Iterable<string>): Promise<void> {
        const set = new Set(ids);
        if (set.size === 0) return;
        await this._mutate((n) => set.has(n.id));
    }

    /**
     * Apply spent-set reconciliation. `predicate(note)` returns true when
     * the note's nullifier was observed on-chain. Persists once if any
     * flip occurred.
     */
    async applySpent(predicate: (note: StoredNote) => boolean): Promise<void> {
        await this._mutate(predicate);
    }

    private async _mutate(predicate: (n: StoredNote) => boolean): Promise<void> {
        let mutated = false;
        for (const n of this.snapshot.notes) {
            if (!n.spent && predicate(n)) {
                n.spent = true;
                mutated = true;
            }
        }
        if (mutated) await this.store.save(this.snapshot);
    }
}
