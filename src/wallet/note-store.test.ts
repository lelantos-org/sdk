import { describe, expect, it } from "vitest";
import type { ScanHit } from "../sync/scan.js";
import { addHits, InMemoryNoteStore } from "./note-store.js";

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
