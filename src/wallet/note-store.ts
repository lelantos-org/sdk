// Note storage: the `NoteStore` port plus the in-memory default.
//
// The record schema itself lives in `core/note-record.ts` (tier 0) so
// `InsufficientCoverError` can carry it without an upward dependency.

import { fieldToBytes32, noteId } from "../core/index.js";
import type { ScanHit } from "../sync/scan.js";

export {
    type ConsolidateHint,
    decodeStoredNote,
    type NoteRecord,
    type StoredNote,
} from "../core/note-record.js";

import type { StoredNote } from "../core/note-record.js";
import { SPEND_RESERVATION_MS } from "./constants.js";

/**
 * Whether a note's spend reservation is still standing at `now`.
 *
 * Both readers of `pendingSpendAt` go through this: the selector, which
 * withholds a reserved note, and reconciliation, which releases one that has
 * expired. An unparseable or absent stamp is no reservation — the failure mode
 * of a bad timestamp is a note offered too early, never one stranded forever.
 */
export function withinReservation(pendingSpendAt: string | undefined, now: number): boolean {
    if (pendingSpendAt === undefined) return false;
    const at = Date.parse(pendingSpendAt);
    if (Number.isNaN(at)) return false;
    return now - at < SPEND_RESERVATION_MS;
}

/**
 * Current notes-file schema version.
 *
 * v3 widened `StoredNote.id` from 4 to 16 random bytes. The id is an identity
 * — it keys the nullifier memo, `markSpent` and selection's `only` filter — so
 * a collision retires an unrelated note. See {@link migrateNotesFile}.
 */
export const NOTES_FILE_VERSION = 3;

export interface NotesFile {
    version: 1 | 2 | 3;
    notes: StoredNote[];
    /**
     * Resume point for `syncWallet`: the highest source row id whose notes are
     * known to be accounted for. Absent means "start from the beginning",
     * which is always safe — scanning is idempotent, only slow.
     *
     * A `NoteStore` implementation MUST round-trip this. Dropping it silently
     * turns every sync back into a re-scan from zero.
     */
    cursor?: number;
}

export interface NoteStore {
    load(): Promise<NotesFile>;
    save(file: NotesFile): Promise<void>;
}

/**
 * Bring a loaded file up to {@link NOTES_FILE_VERSION}.
 *
 * v1/v2 ids were 4 random bytes, which collide at a rate a real wallet
 * reaches, so every note is renumbered on the way in. Ids are opaque and
 * wallet-local — nothing off-device and nothing in the note's own record
 * refers to one — so reissuing them costs nothing but is not idempotent
 * across loads, and the caller is expected to persist the result.
 *
 * A no-op on a current file, returned as-is.
 */
export function migrateNotesFile(file: NotesFile): { file: NotesFile; migrated: boolean } {
    if (file.version >= NOTES_FILE_VERSION) return { file, migrated: false };
    return {
        file: {
            ...file,
            version: NOTES_FILE_VERSION,
            notes: file.notes.map((n) => ({ ...n, id: noteId() })),
        },
        migrated: true,
    };
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
 * `{ cursor }` when one is set, `{}` otherwise.
 *
 * Spread rather than assigned so the key stays absent under
 * `exactOptionalPropertyTypes`, which rejects an explicit `undefined`.
 */
function cursorOf(file: NotesFile): { cursor?: number } {
    return file.cursor === undefined ? {} : { cursor: file.cursor };
}

/**
 * Append `ScanHit[]` to a `NotesFile`. Idempotent: existing `cm`s are skipped.
 *
 * `known` lets a caller that appends repeatedly — the sync loop, once per page
 * — carry the membership set across calls instead of rebuilding it from every
 * stored note each time, which is O(notes x pages) over a long sync. It is
 * updated in place, so a caller that passes one must not reuse it against a
 * different file.
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
