// Note storage: the `NoteStore` port plus the in-memory default.
//
// The record schema itself lives in `core/note-record.ts` (tier 0) so
// `InsufficientCoverError` can carry it without an upward dependency.

import { fieldToBytes32, shortId } from "../core/index.js";
import type { ScanHit } from "../sync/scan.js";

export {
    type ConsolidateHint,
    decodeStoredNote,
    type NoteRecord,
    type StoredNote,
} from "../core/note-record.js";

import type { StoredNote } from "../core/note-record.js";

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
        // Clone so caller mutations don't affect internal state.
        return { version: this.file.version, notes: [...this.file.notes] };
    }

    async save(file: NotesFile): Promise<void> {
        this.file = { version: 2, notes: [...file.notes] };
    }
}

/** Append `ScanHit[]` to a `NotesFile`. Idempotent: existing `cm`s are skipped. */
export function addHits(
    file: NotesFile,
    hits: ScanHit[],
): { added: StoredNote[]; skipped: number } {
    const known = new Set(file.notes.map((n) => n.cm));
    const added: StoredNote[] = [];
    let skipped = 0;
    for (const h of hits) {
        const cmHex = fieldToBytes32(h.cm);
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
            rcvDep: h.rcvDep.toString(),
            cm: cmHex,
            leafIndex: h.leafIndex,
            spent: false,
            discoveredAt: new Date().toISOString(),
            firstSeenBlock: h.blockNumber,
        });
    }
    file.notes.push(...added);
    return { added, skipped };
}
