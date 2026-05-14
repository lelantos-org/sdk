// Wallet sync: fetch from `NoteSource`, trial-decrypt with ivk, persist to `NoteStore`.

import type { Field, Jubjub } from "../crypto/index.js";
import { flagKeyFromAddressDk } from "../notes/aux.js";
import type { Scanner } from "../sync/scanner.js";
import type { NoteSource } from "./note-source.js";
import type { NoteStore } from "./note-store.js";
import { addHits } from "./note-store.js";

export interface SyncResult {
    fetched: number;
    hits: number;
    added: number;
    skipped: number;
}

export interface SyncDeps {
    J: Jubjub;
    ivk: Field;
    dk: Field;
    source: NoteSource;
    store: NoteStore;
    scanner: Scanner;
}

export interface SyncProgress {
    phase: "fetching" | "scanning" | "persisting" | "done";
    fetched: number;
    hits: number;
}

export async function syncWallet(
    deps: SyncDeps,
    opts: { limit?: number; onProgress?: (p: SyncProgress) => void } = {},
): Promise<SyncResult> {
    const { detection } = flagKeyFromAddressDk(deps.J, deps.dk);

    opts.onProgress?.({ phase: "fetching", fetched: 0, hits: 0 });
    const inputs = await deps.source.listNotes({ limit: opts.limit ?? 1000 });

    opts.onProgress?.({ phase: "scanning", fetched: inputs.length, hits: 0 });
    const hits = await deps.scanner.scan(deps.ivk, inputs, detection);

    opts.onProgress?.({ phase: "persisting", fetched: inputs.length, hits: hits.length });
    const file = await deps.store.load();
    const { added, skipped } = addHits(file, hits);
    await deps.store.save(file);

    opts.onProgress?.({ phase: "done", fetched: inputs.length, hits: hits.length });
    return { fetched: inputs.length, hits: hits.length, added: added.length, skipped };
}
