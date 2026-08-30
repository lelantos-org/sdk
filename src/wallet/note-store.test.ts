import { describe, expect, it } from "vitest";
import type { StoredNote } from "../core/note-record.js";
import type { ScanHit } from "../sync/scan.js";
import {
    addHits,
    InMemoryNoteStore,
    migrateNotesFile,
    NOTES_FILE_VERSION,
    type NotesFile,
} from "./note-store.js";

function hit(cm: bigint, blockNumber: number): ScanHit {
    return {
        asset: 1n,
        value: 100n,
        rho: 2n,
        rcm: 3n,
        rcvDep: 4n,
        cm,
        leafIndex: Number(cm),
        blockNumber,
    };
}

describe("addHits", () => {
    it("records the block a note landed in", async () => {
        // `firstSeenBlock` is what makes the selector's spend cooldown fire;
        // without it the cooldown is inert.
        const store = new InMemoryNoteStore();
        const file = await store.load();

        const { added } = addHits(file, [hit(10n, 4242)]);

        expect(added[0]?.firstSeenBlock).toBe(4242);
    });

    it("still dedupes by commitment", async () => {
        const file = await new InMemoryNoteStore().load();
        addHits(file, [hit(10n, 1)]);
        const { added, skipped } = addHits(file, [hit(10n, 2)]);

        expect(added).toHaveLength(0);
        expect(skipped).toBe(1);
    });
});

const note = (id: string, cm: string): StoredNote => ({
    id,
    asset: "1",
    value: "10",
    rho: "2",
    rcm: "3",
    rcvDep: "4",
    cm,
    leafIndex: 0,
    spent: false,
    discoveredAt: "2026-01-01T00:00:00.000Z",
});

const v2 = (notes: StoredNote[]): NotesFile => ({ version: 2, notes, cursor: 42 });

describe("migrateNotesFile", () => {
    // v1/v2 ids were 4 random bytes. They collide at a rate a real wallet
    // reaches, and the id is what `markSpent` and the nullifier memo key on.
    it("reissues every id at the current width", () => {
        const before = [note("aabbccdd", "0xaa"), note("11223344", "0xbb")];
        const { file, migrated } = migrateNotesFile(v2(before));

        expect(migrated).toBe(true);
        expect(file.version).toBe(NOTES_FILE_VERSION);
        for (const n of file.notes) expect(n.id).toMatch(/^[0-9a-f]{32}$/);
        expect(new Set(file.notes.map((n) => n.id)).size).toBe(2);
    });

    it("preserves everything except the id", () => {
        const before = [note("aabbccdd", "0xaa")];
        const { file } = migrateNotesFile(v2(before));

        expect(file.cursor).toBe(42);
        expect(file.notes[0]).toMatchObject({ ...before[0], id: file.notes[0]!.id });
        // The old ids are gone, which is the point.
        expect(file.notes[0]!.id).not.toBe("aabbccdd");
    });

    // A colliding pair is exactly the state the migration exists to clear.
    it("splits ids that collided under the old width", () => {
        const { file } = migrateNotesFile(v2([note("dead", "0xaa"), note("dead", "0xbb")]));
        expect(file.notes[0]!.id).not.toBe(file.notes[1]!.id);
    });

    it("is a no-op on a current file, returned as-is", () => {
        const current: NotesFile = {
            version: NOTES_FILE_VERSION,
            notes: [note("x".repeat(32), "0xaa")],
        };
        const { file, migrated } = migrateNotesFile(current);
        expect(migrated).toBe(false);
        expect(file).toBe(current);
    });

    it("handles an empty file", () => {
        const { file, migrated } = migrateNotesFile({ version: 1, notes: [] });
        expect(migrated).toBe(true);
        expect(file.version).toBe(NOTES_FILE_VERSION);
        expect(file.notes).toEqual([]);
    });
});

describe("NoteCache.open", () => {
    // The migration reissues ids, so an unpersisted one hands out a different
    // set on the next load and strands any id the caller still holds.
    it("writes the upgraded file back to the store", async () => {
        const { NoteCache } = await import("./note-cache.js");
        const saved: NotesFile[] = [];
        const stored: NotesFile = v2([note("aabbccdd", "0xaa")]);
        const store = {
            load: async () => stored,
            save: async (f: NotesFile) => {
                saved.push(f);
            },
        };

        const cache = await NoteCache.open(store);

        expect(saved).toHaveLength(1);
        expect(saved[0]!.version).toBe(NOTES_FILE_VERSION);
        expect(cache.notes[0]!.id).toMatch(/^[0-9a-f]{32}$/);
    });

    it("does not write when the file is already current", async () => {
        const { NoteCache } = await import("./note-cache.js");
        const saved: NotesFile[] = [];
        const stored: NotesFile = { version: NOTES_FILE_VERSION, notes: [] };
        await NoteCache.open({
            load: async () => stored,
            save: async (f: NotesFile) => {
                saved.push(f);
            },
        });
        expect(saved).toHaveLength(0);
    });
});
