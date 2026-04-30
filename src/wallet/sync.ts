// Wallet sync — fetch encrypted notes from a `NoteSource`, trial-decrypt
// with this wallet's ivk, persist hits to the `NoteStore`.

import type { Jubjub, Field } from "../crypto/index";
import { flagKeyFromAddressDk } from "../aux";
import type { NoteSource } from "./note-source";
import type { NoteStore } from "./note-store";
import { addHits } from "./note-store";
import type { Scanner } from "./scanner";

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

export async function syncWallet(
    deps: SyncDeps,
    opts: { limit?: number } = {},
): Promise<SyncResult> {
    const { detection } = flagKeyFromAddressDk(deps.J, deps.dk);
    const inputs = await deps.source.listNotes({ limit: opts.limit ?? 1000 });

    const hits = await deps.scanner.scan(deps.ivk, inputs, detection);
    const file = await deps.store.load();
    const { added, skipped } = addHits(file, hits);
    await deps.store.save(file);

    return { fetched: inputs.length, hits: hits.length, added: added.length, skipped };
}
