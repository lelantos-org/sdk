// Primitives that track the circuit and the on-disk note format rather than
// the wallet API, published at `@lelantos-org/sdk/internal`.
//
// Separate from the domain subpaths because these carry no stability
// guarantee: they move whenever the circuit or the stored-note encoding does,
// including in a patch release. Anything imported from here should be pinned
// against a specific `@lelantos-org/circuits` version.

export {
    type CircomTransactInput,
    dummyInputAt,
    fiatShamirZ,
    hornerEval,
    toCircomInput,
} from "./circuit/index.js";
export { decodeStoredNote } from "./core/note-record.js";
export {
    decodeNotePayload,
    encodeNotePayload,
    type NotePayload,
} from "./notes/index.js";
export { auxDigest } from "./protocol/abi-hash.js";
