import { describe, expect, it } from "vitest";
import type { ScanHit } from "../../sync/scan.js";
import { storedNote } from "../../test-utils/wallet.js";
import { addHits, InMemoryNoteStore, NOTES_FILE_VERSION, type NotesFile } from "./note-store.js";

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
        const saved: NotesFile[] = [];
        const stale = { version: 2, notes: [storedNote("aabbccdd")] };

        await expect(NoteCache.open(storeOf(stale, saved))).rejects.toMatchObject({
            code: "WALLET_CONFIG",
        });
        expect(saved).toHaveLength(0);
    });

    it("does not write when opening a current file", async () => {
        const { NoteCache } = await import("./note-cache.js");
        const saved: NotesFile[] = [];
        await NoteCache.open(storeOf({ version: NOTES_FILE_VERSION, notes: [] }, saved));
        expect(saved).toHaveLength(0);
    });
});
