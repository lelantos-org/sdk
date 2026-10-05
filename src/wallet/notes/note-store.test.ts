import { describe, expect, it } from "vitest";
import type { ScanHit } from "../../sync/scan.js";
import { storedNote } from "../../test-utils/wallet.js";
import {
    addHits,
    decodeStoredNote,
    InMemoryNoteStore,
    NOTES_FILE_VERSION,
    type NotesFile,
} from "./note-store.js";
import { filterNotes } from "./read-ops.js";

/** A diversifier that needs all 16 bytes, so a narrowing conversion would lose it. */
const D = (1n << 128n) - 5n;

function hit(cm: bigint, blockNumber: number, d = 0n): ScanHit {
    return {
        asset: 1n,
        value: 100n,
        rho: 2n,
        rcm: 3n,
        d,
        cm,
        leafIndex: Number(cm),
        blockNumber,
    };
}

describe("addHits", () => {
    it("records the block a note landed in", async () => {
        // The selector's spend cooldown depends on `firstSeenBlock`.
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

    it("records the diversifier a note was received under", async () => {
        // A spend derives the note's `pk` from the stored `d`.
        const file = await new InMemoryNoteStore().load();

        const { added } = addHits(file, [hit(10n, 1, D), hit(11n, 1)]);

        expect(added.map((n) => n.d)).toEqual([D.toString(), "0"]);
    });
});

describe("the stored note's diversifier", () => {
    it("survives a save, a load and both decoders", async () => {
        const store = new InMemoryNoteStore();
        const file = await store.load();
        addHits(file, [hit(10n, 1, D)]);
        await store.save(file);

        // Through JSON, as a persistent store would hold it.
        const loaded: NotesFile = JSON.parse(JSON.stringify(await store.load()));
        const [stored] = loaded.notes;
        if (!stored) throw new Error("expected one note");

        expect(loaded.version).toBe(3);
        expect(decodeStoredNote(stored).d).toBe(D);
        expect(filterNotes(loaded.notes)[0]?.notePayload().d).toBe(D);
    });
});

describe("NoteCache.open", () => {
    const storeOf = (stored: unknown, saved: NotesFile[] = []) => ({
        load: async () => stored as NotesFile,
        save: async (f: NotesFile) => {
            saved.push(f);
        },
    });

    it("rejects a file on another schema version", async () => {
        const { NoteCache } = await import("./note-cache.js");
        expect(NOTES_FILE_VERSION).toBe(3);
        for (const version of [NOTES_FILE_VERSION - 1, NOTES_FILE_VERSION + 1, undefined]) {
            const saved: NotesFile[] = [];
            const other = { version, notes: [storedNote("aabbccdd")] };

            await expect(NoteCache.open(storeOf(other, saved))).rejects.toMatchObject({
                code: "WALLET_CONFIG",
            });
            expect(saved).toHaveLength(0);
        }
    });

    it("does not write when opening a current file", async () => {
        const { NoteCache } = await import("./note-cache.js");
        const saved: NotesFile[] = [];
        await NoteCache.open(storeOf({ version: NOTES_FILE_VERSION, notes: [] }, saved));
        expect(saved).toHaveLength(0);
    });
});
