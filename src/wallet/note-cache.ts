// In-memory note cache + persistence wrapper. Owns the mutable `NotesFile`
// snapshot so `Wallet` stays a thin facade. All cache mutations route
// through here, keeping store writes and in-memory state in lockstep.

import {
    AWAIT_COMMITMENTS_DEFAULT_MAX_ATTEMPTS,
    AWAIT_COMMITMENTS_DEFAULT_POLL_MS,
    AWAIT_COMMITMENTS_SYNC_LIMIT,
} from "./constants.js";
import type { NoteStore, NotesFile, StoredNote } from "./note-store.js";

export interface AwaitCommitmentsOpts {
    signal?: AbortSignal;
    pollMs?: number;
    maxAttempts?: number;
}

/// Resolve once every `cms` entry appears in `read()`. Polls `sync()`
/// between attempts; bails on abort or attempt cap.
export async function awaitCommitments(
    cms: string[],
    read: () => readonly StoredNote[],
    sync: (limit: number) => Promise<unknown>,
    opts: AwaitCommitmentsOpts = {},
): Promise<void> {
    if (cms.length === 0) return;
    const target = cms.map((c) => c.toLowerCase());
    const pollMs = opts.pollMs ?? AWAIT_COMMITMENTS_DEFAULT_POLL_MS;
    const maxAttempts = opts.maxAttempts ?? AWAIT_COMMITMENTS_DEFAULT_MAX_ATTEMPTS;
    const allSeen = (): boolean => {
        const seen = new Set(read().map((n) => n.cm.toLowerCase()));
        return target.every((c) => seen.has(c));
    };
    const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
            if (opts.signal?.aborted) return resolve();
            const t = setTimeout(() => {
                opts.signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(t);
                resolve();
            };
            opts.signal?.addEventListener("abort", onAbort, { once: true });
        });
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (opts.signal?.aborted) return;
        if (allSeen()) return;
        await sync(AWAIT_COMMITMENTS_SYNC_LIMIT);
        if (opts.signal?.aborted || allSeen()) return;
        await sleep(pollMs);
    }
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

    get notes(): StoredNote[] {
        return this.snapshot.notes;
    }

    /// Replace the in-memory snapshot with the store's current state.
    async refresh(): Promise<void> {
        this.snapshot = await this.store.load();
    }

    /// Drop notes flagged `spent: true`. Returns removed count.
    async compact(): Promise<{ removed: number }> {
        const before = this.snapshot.notes.length;
        const live = this.snapshot.notes.filter((n) => !n.spent);
        const removed = before - live.length;
        if (removed === 0) return { removed: 0 };
        this.snapshot.notes = live;
        await this.store.save(this.snapshot);
        return { removed };
    }

    /// Flip `spent` for every note whose id is in `ids`, then persist.
    async markSpent(ids: Iterable<string>): Promise<void> {
        const set = new Set(ids);
        if (set.size === 0) return;
        let mutated = false;
        for (const n of this.snapshot.notes) {
            if (set.has(n.id) && !n.spent) {
                n.spent = true;
                mutated = true;
            }
        }
        if (mutated) await this.store.save(this.snapshot);
    }

    /// Apply spent-set reconciliation. `predicate(note)` returns true when
    /// the note's nullifier was observed on-chain. Persists once if any
    /// flip occurred.
    async applySpent(predicate: (note: StoredNote) => boolean): Promise<void> {
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
