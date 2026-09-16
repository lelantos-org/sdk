// Paging coverage for `syncWallet`. Every fixture is larger than the page size, since a
// single-request sync would pass any fixture that fits in one page.

import { describe, expect, it } from "vitest";
import type { Field, Jubjub } from "../crypto/index.js";
import { NoteCache } from "../wallet/notes/note-cache.js";
import { InMemoryNoteStore } from "../wallet/notes/note-store.js";
import type { ListNotesOpts, NotePage, NoteSource } from "./note-source.js";
import { syncWallet } from "./notes-sync.js";
import type { ScanHit, ScanInput } from "./scan.js";
import type { Scanner } from "./scanner.js";

/** A feed row: an id and its leaf index. */
interface Row {
    id: number;
    leafIndex: number;
}

function rows(from: number, to: number): Row[] {
    return Array.from({ length: to - from + 1 }, (_, i) => ({
        id: from + i,
        leafIndex: from + i,
    }));
}

function toInput(r: Row): ScanInput {
    return {
        ciphertext: new Uint8Array([0, 0]),
        epk: new Uint8Array(32),
        cm: BigInt(r.id),
        leafIndex: r.leafIndex,
        blockNumber: 1,
    };
}

/**
 * Append-only feed over `all`, paging on `after` as the server does. `watermark` models the
 * `matches` backfill: rows above it are served but must not be resumed from.
 */
class FakeSource implements NoteSource {
    readonly requests: Array<{ after: number; limit: number }> = [];

    constructor(
        private readonly all: Row[],
        private readonly watermark = Number.POSITIVE_INFINITY,
    ) {}

    async listNotes(opts: ListNotesOpts = {}): Promise<NotePage> {
        const after = opts.after ?? 0;
        const limit = opts.limit ?? 1000;
        this.requests.push({ after, limit });

        const page = this.all.filter((r) => r.id > after).slice(0, limit);
        let hi = after;
        for (const r of page) if (r.id > hi) hi = r.id;
        return {
            inputs: page.map(toInput),
            nextAfter: hi,
            resumeAfter: Math.min(hi, this.watermark),
        };
    }
}

/** Feed that ignores `after`, modelling a server without cursor support. */
class StuckSource implements NoteSource {
    calls = 0;

    constructor(private readonly page: Row[]) {}

    async listNotes(): Promise<NotePage> {
        this.calls++;
        let hi = 0;
        for (const r of this.page) if (r.id > hi) hi = r.id;
        return { inputs: this.page.map(toInput), nextAfter: hi, resumeAfter: hi };
    }
}

/** Reports a hit for every input whose `leafIndex` is in `mine`. */
class FakeScanner implements Scanner {
    constructor(private readonly mine: Set<number>) {}

    async scan(_ivk: Field, inputs: ScanInput[]): Promise<ScanHit[]> {
        return inputs
            .filter((i) => this.mine.has(i.leafIndex))
            .map((i) => ({
                asset: 1n,
                value: 10n,
                rho: 0n,
                rcm: 0n,
                rcvDep: 0n,
                cm: i.cm,
                leafIndex: i.leafIndex,
                blockNumber: i.blockNumber,
            }));
    }
}

async function deps(source: NoteSource, scanner: Scanner, store = new InMemoryNoteStore()) {
    const cache = await NoteCache.open(store);
    return {
        deps: {
            J: {} as Jubjub,
            ivk: 1n as Field,
            source,
            sink: cache,
            scanner,
        },
        store,
        cache,
    };
}

describe("syncWallet paging", () => {
    it("finds a note past the first page", async () => {
        // Note 1200 is beyond the first `limit` rows.
        const source = new FakeSource(rows(1, 2000));
        const { deps: d, store } = await deps(source, new FakeScanner(new Set([1200])));

        const result = await syncWallet(d, { limit: 500 });

        expect(result.fetched).toBe(2000);
        expect(result.added).toBe(1);
        const file = await store.load();
        expect(file.notes[0]?.leafIndex).toBe(1200);
    });

    it("stops on the first empty page, not the first short one", async () => {
        const source = new FakeSource(rows(1, 1200));
        const { deps: d } = await deps(source, new FakeScanner(new Set()));

        const result = await syncWallet(d, { limit: 500 });

        // 500, 500, 200, 0: only the empty page ends paging, since a server that caps `limit`
        // returns short pages before the end of the feed.
        expect(result.pages).toBe(4);
        expect(result.stoppedBy).toBe("exhausted");
        expect(source.requests.map((r) => r.after)).toEqual([0, 500, 1000, 1200]);
    });

    it("keeps paging when the server caps `limit` below the requested size", async () => {
        // fmd-webserver caps page size server-side, so every page is short.
        const all = rows(1, 1000);
        const capped: NoteSource = {
            async listNotes(opts) {
                const after = opts?.after ?? 0;
                const page = all.filter((r) => r.id > after).slice(0, 200);
                const hi = page.at(-1)?.id ?? after;
                return { inputs: page.map(toInput), nextAfter: hi, resumeAfter: hi };
            },
        };
        const { deps: d } = await deps(capped, new FakeScanner(new Set([777])));

        const result = await syncWallet(d, { limit: 1000 });

        expect(result.fetched).toBe(1000);
        expect(result.added).toBe(1);
        expect(result.stoppedBy).toBe("exhausted");
    });

    it("resumes from the persisted cursor instead of re-fetching", async () => {
        const source = new FakeSource(rows(1, 600));
        const { deps: d, store } = await deps(source, new FakeScanner(new Set()));

        await syncWallet(d, { limit: 500 });
        const first = source.requests.length;
        const second = await syncWallet(d, { limit: 500 });

        expect((await store.load()).cursor).toBe(600);
        // A caught-up poll transfers no rows.
        expect(second.fetched).toBe(0);
        expect(source.requests.slice(first)).toEqual([{ after: 600, limit: 500 }]);
    });

    it("does not advance the persisted cursor past the backfill watermark", async () => {
        // Rows above 700 are live matches; backfill has reached only 700, so later ids may still be
        // inserted and must be re-requested next sync.
        const source = new FakeSource(rows(1, 1200), 700);
        const { deps: d, store } = await deps(source, new FakeScanner(new Set()));

        const result = await syncWallet(d, { limit: 500 });

        expect(result.fetched).toBe(1200);
        expect((await store.load()).cursor).toBe(700);
    });

    it("terminates when the server ignores `after`", async () => {
        // Otherwise full pages would loop until the page cap.
        const source = new StuckSource(rows(1, 500));
        const { deps: d } = await deps(source, new FakeScanner(new Set()));

        const result = await syncWallet(d, { limit: 500 });

        expect(result.pages).toBe(2);
        expect(source.calls).toBe(2);
        // Reported so callers can distinguish it from caught up.
        expect(result.stoppedBy).toBe("cursorStalled");
    });

    it("keeps notes and cursor found before a mid-sync failure", async () => {
        const good = new FakeSource(rows(1, 2000));
        let calls = 0;
        const failing: NoteSource = {
            async listNotes(opts) {
                if (++calls === 3) throw new Error("network down");
                return good.listNotes(opts);
            },
        };
        const { deps: d, store } = await deps(failing, new FakeScanner(new Set([10])));

        await expect(syncWallet(d, { limit: 500 })).rejects.toThrow("network down");

        const file = await store.load();
        expect(file.notes).toHaveLength(1);
        // Two pages were consumed before the third request threw.
        expect(file.cursor).toBe(1000);
    });
});

describe("syncWallet cancellation", () => {
    it("stops at the next page boundary when aborted", async () => {
        // Without a signal a sync can page through `MAX_PAGES * limit` notes.
        const source = new FakeSource(rows(1, 5000));
        const ctrl = new AbortController();
        const { deps: d } = await deps(source, new FakeScanner(new Set()));

        // Abort once the feed has served two pages.
        const inner = d.source.listNotes.bind(d.source);
        let pages = 0;
        d.source = {
            async listNotes(opts) {
                if (++pages === 2) ctrl.abort();
                return inner(opts);
            },
        };

        const result = await syncWallet(d, { limit: 500, signal: ctrl.signal });

        expect(result.stoppedBy).toBe("aborted");
        expect(result.pages).toBe(2);
    });

    it("persists what it scanned before the abort", async () => {
        // Cancelling must not force a full re-scan next time.
        const source = new FakeSource(rows(1, 5000));
        const ctrl = new AbortController();
        const { deps: d, store } = await deps(source, new FakeScanner(new Set([10])));

        const inner = d.source.listNotes.bind(d.source);
        let pages = 0;
        d.source = {
            async listNotes(opts) {
                if (++pages === 2) ctrl.abort();
                return inner(opts);
            },
        };

        await syncWallet(d, { limit: 500, signal: ctrl.signal });

        const file = await store.load();
        expect(file.notes).toHaveLength(1);
        expect(file.cursor).toBe(1000);
    });

    it("does nothing at all for an already-aborted signal", async () => {
        const source = new FakeSource(rows(1, 5000));
        const { deps: d } = await deps(source, new FakeScanner(new Set()));

        const result = await syncWallet(d, {
            limit: 500,
            signal: AbortSignal.abort(new Error("gone")),
        });

        expect(result.stoppedBy).toBe("aborted");
        expect(result.pages).toBe(0);
        expect(source.requests).toHaveLength(0);
    });
});
