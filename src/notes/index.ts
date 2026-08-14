// Note construction: the note struct, its payload codec, ECDH encryption,
// and the per-output aux payload (FMD clue + ciphertext).

export {
    type BuildAuxArgs,
    buildOutputAux,
    ON_CURVE_IDENTITY,
    type OutputAux,
    type OutputAuxWithWitness,
} from "./aux.js";
export {
    CLUE_BITS_PREFIX_BYTES,
    clueBitsToPrefix,
    decodeNotePayload,
    encodeNotePayload,
    type NotePayload,
    stripClueBitsPrefix,
    withClueBitsPrefix,
} from "./codec.js";
export { decryptNote, encryptNote } from "./encrypt.js";
export type { EncryptedNote, Note, SpentNote } from "./note.js";
export {
    freshNoteRandomness,
    freshOutput,
    freshOutputAuxRandomness,
    type NoteOutputAuxRandomness,
    type NoteOutputRandomness,
    type NoteRandomness,
} from "./randomness.js";
