// In-memory note cache. Persistence is the application's job.

import type { Field } from "./crypto/index.js";
import type { Note } from "./notes.js";

export interface CachedNote {
    note: Note;
    cm: Field;
    nf: Field;
    leafIndex: number;
    spent: boolean;
    /// Lazy-root model: true between user POST and observed `BatchCommitted`
    /// covering the leafIndex. While `pending`, the note has no chain root
    /// to spend against and `unspent()` filters it out.
    pending: boolean;
}

export class NoteCache {
    private byCm = new Map<string, CachedNote>();
    private byNf = new Map<string, CachedNote>();

    insert(c: CachedNote): void {
        this.byCm.set(c.cm.toString(), c);
        this.byNf.set(c.nf.toString(), c);
    }

    markSpent(nf: Field): void {
        const c = this.byNf.get(nf.toString());
        if (c) c.spent = true;
    }

    /// Flip `pending=false` once the note's batch lands on chain.
    markCommitted(cm: Field): void {
        const c = this.byCm.get(cm.toString());
        if (c) c.pending = false;
    }

    all(): CachedNote[] {
        return [...this.byCm.values()];
    }

    unspent(): CachedNote[] {
        return this.all().filter((c) => !c.spent && !c.pending);
    }

    unspentForAsset(asset: Field): CachedNote[] {
        return this.unspent().filter((c) => c.note.asset === asset);
    }

    balance(asset: Field): bigint {
        return this.unspentForAsset(asset).reduce((sum, c) => sum + c.note.value, 0n);
    }

    clear(): void {
        this.byCm.clear();
        this.byNf.clear();
    }
}
