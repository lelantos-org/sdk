import { type NoteStore, type NotesFile } from "@lelantos-org/sdk";
export async function __block() {

class IndexedDbNoteStore implements NoteStore {
    async load(): Promise<NotesFile> {
        const json = ((await idbGet("lelantos-notes")) as string | undefined) ?? '{"version":2,"notes":[]}';
        return JSON.parse(json);
    }
    async save(file: NotesFile): Promise<void> {
        await idbSet("lelantos-notes", JSON.stringify(file));
    }
}

const wallet = await Wallet.create(keySource, { ...config, noteStore: new IndexedDbNoteStore() });
}
