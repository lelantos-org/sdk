// Wallet sync — fetch encrypted notes from a `NoteSource`, trial-decrypt
// with this wallet's ivk, persist hits to the `NoteStore`.

import { Jubjub, type Field } from "../crypto/index";
import { flagKeyFromAddressDk } from "../aux";
import { scanNotes } from "../sync";
import type { NoteSource } from "./note-source";
import type { NoteStore } from "./note-store";
import { addHits } from "./note-store";

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
}

export async function syncWallet(
    deps: SyncDeps,
    opts: { limit?: number } = {},
): Promise<SyncResult> {
    const { detection } = flagKeyFromAddressDk(deps.J, deps.dk);
    const inputs = await deps.source.listNotes({ limit: opts.limit ?? 1000 });

    const hits = scanNotes(deps.J, deps.ivk, inputs, detection);
    const file = await deps.store.load();
    const { added, skipped } = addHits(file, hits);
    await deps.store.save(file);

    return { fetched: inputs.length, hits: hits.length, added: added.length, skipped };
}
