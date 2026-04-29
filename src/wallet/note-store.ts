// Persistent-note schema + storage abstraction.
//
// SDK ships an `InMemoryNoteStore` default. Application owners plug in
// concrete backends (file, IndexedDB, SQLite, encrypted store) by
// implementing the small `NoteStore` interface.

import type { ScanHit } from "../sync";

export interface StoredNote {
    id: string;
    asset: string;     // bigint as decimal string
    value: string;
    rho: string;
    rcm: string;
    cm: string;        // 0x-hex 32 B
    leafIndex: number;
    spent: boolean;
    discoveredAt: string;
    /// Chain block at which the note was first observed by the wallet. Used
    /// by the selector to enforce a spend cooldown that breaks same-block
    /// change-link heuristics. Optional; when absent, cooldown is skipped.
    firstSeenBlock?: number;
}

export interface NotesFile {
    version: 1 | 2;
    notes: StoredNote[];
}

export interface NoteStore {
    load(): Promise<NotesFile>;
    save(file: NotesFile): Promise<void>;
}

export class InMemoryNoteStore implements NoteStore {
    private file: NotesFile = { version: 2, notes: [] };

    async load(): Promise<NotesFile> {
        // Return a deep-ish clone so callers mutating the result don't
        // change our internal copy.
        return { version: this.file.version, notes: [...this.file.notes] };
    }

    async save(file: NotesFile): Promise<void> {
        this.file = { version: 2, notes: [...file.notes] };
    }
}

/// Append `ScanHit[]` (from `scanNotes`) to a `NotesFile`. Idempotent: a hit
/// whose `cm` already exists is skipped.
export function addHits(
    file: NotesFile,
    hits: ScanHit[],
): { added: StoredNote[]; skipped: number } {
    const known = new Set(file.notes.map((n) => n.cm));
    const added: StoredNote[] = [];
    let skipped = 0;
    for (const h of hits) {
        const cmHex = "0x" + h.cm.toString(16).padStart(64, "0");
        if (known.has(cmHex)) {
            skipped++;
            continue;
        }
        added.push({
            id: shortId(),
            asset: h.asset.toString(),
            value: h.value.toString(),
            rho: h.rho.toString(),
            rcm: h.rcm.toString(),
            cm: cmHex,
            leafIndex: h.leafIndex,
            spent: false,
            discoveredAt: new Date().toISOString(),
        });
    }
    file.notes.push(...added);
    return { added, skipped };
}

export function findById(file: NotesFile, id: string): StoredNote | undefined {
    return file.notes.find((n) => n.id === id);
}

export function markSpent(file: NotesFile, id: string): void {
    const n = findById(file, id);
    if (n) n.spent = true;
}

function shortId(): string {
    if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
        throw new Error("Web Crypto API not available; provide a polyfill");
    }
    const b = new Uint8Array(4);
    globalThis.crypto.getRandomValues(b);
    let h = "";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}
