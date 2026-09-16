// Note storage: the `NoteStore` port and the in-memory default.
//
// The record schema (`StoredNote`, `NotesFile`) lives in `protocol/note-record.ts` so the
// wallet-agnostic sync engine can name it; `ConsolidateHint` lives with `InsufficientCoverError`.

import { fieldToBytes32 } from "../../core/hex.js";
import { noteId } from "../../core/random.js";
import type { ScanHit } from "../../sync/scan.js";

export type { ConsolidateHint } from "../../errors/funds.js";
export {
    decodeStoredNote,
    type NoteRecord,
    type NotesFile,
    type StoredNote,
} from "../../protocol/note-record.js";

import type { NotesFile, StoredNote } from "../../protocol/note-record.js";
import { SPEND_RESERVATION_MS } from "../constants.js";

/**
 * Whether a note's spend reservation is still active at `now`.
 *
 * Shared by the selector (which withholds reserved notes) and reconciliation (which releases
 * expired ones). An absent or unparseable stamp counts as no reservation, so a bad timestamp can
 * only offer a note early, never strand it.
 */
export function withinReservation(pendingSpendAt: string | undefined, now: number): boolean {
    if (pendingSpendAt === undefined) return false;
    const at = Date.parse(pendingSpendAt);
    if (Number.isNaN(at)) return false;
    return now - at < SPEND_RESERVATION_MS;
}

/**
 * The notes-file schema version this SDK reads and writes.
 *
 * `StoredNote.id` is 16 random bytes. The id keys the nullifier memo, `markSpent` and selection's
 * `only` filter, so a collision would retire an unrelated note.
 */
export const NOTES_FILE_VERSION = 1;

export interface NoteStore {
    load(): Promise<NotesFile>;
    save(file: NotesFile): Promise<void>;
}

export class InMemoryNoteStore implements NoteStore {
    private file: NotesFile = { version: NOTES_FILE_VERSION, notes: [] };

    async load(): Promise<NotesFile> {
        // Clone so caller mutations don't affect internal state.
        return { version: this.file.version, notes: [...this.file.notes], ...cursorOf(this.file) };
    }

    async save(file: NotesFile): Promise<void> {
        this.file = { version: NOTES_FILE_VERSION, notes: [...file.notes], ...cursorOf(file) };
    }
}

/**
 * `{ cursor }` when set, `{}` otherwise. Spread so the key stays absent under
 * `exactOptionalPropertyTypes`, which rejects an explicit `undefined`.
 */
function cursorOf(file: NotesFile): { cursor?: number } {
    return file.cursor === undefined ? {} : { cursor: file.cursor };
}

/**
 * Append `ScanHit[]` to a `NotesFile`. Idempotent: existing `cm`s are skipped.
 *
 * `known` lets a repeated caller (the sync loop, once per page) reuse the commitment set instead
 * of rebuilding it per call, which is O(notes x pages). It is updated in place and must not be
 * reused against a different file.
 */
export function addHits(
    file: NotesFile,
    hits: ScanHit[],
    known: Set<string> = new Set(file.notes.map((n) => n.cm)),
): { added: StoredNote[]; skipped: number } {
    const added: StoredNote[] = [];
    let skipped = 0;
    for (const h of hits) {
        const cmHex = fieldToBytes32(h.cm);
        if (known.has(cmHex)) {
            skipped++;
            continue;
        }
        known.add(cmHex);
        added.push({
            id: noteId(),
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
