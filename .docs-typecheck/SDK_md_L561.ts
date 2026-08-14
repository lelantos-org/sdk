import type { NoteSource } from "@lelantos-org/sdk";
import type { ScanInput } from "@lelantos-org/sdk/sync";
export async function __block() {

class IndexerNoteSource implements NoteSource {
    async listNotes(opts?: { limit?: number }): Promise<ScanInput[]> {
        return []; // fetch from your indexer
    }
}
}
