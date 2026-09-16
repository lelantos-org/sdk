// Raw JSON → domain values, one decoder per response.
//
// Wire encoding stops here. Every response is validated through `services/http/decode`
// and returned as `Field`/`Uint8Array`, so a malformed response raises a
// `WireFormatError` naming the offending JSON path instead of a `TypeError`
// surfacing later inside a store.
//
// The backend is inconsistent about the `0x` prefix: tree state, nullifiers and
// chunk leaf hashes carry it; note/match commitments, ciphertexts and packed
// points do not. All are hex, so all go through `hexInt`/`hexBytes` and none
// through `bigintFrom`, which also accepts decimal: a bare-hex value with only
// decimal digits would silently decode as the wrong number.

import { bool, hexBytes, hexBytesN, hexInt, int, mapArr, obj } from "../http/decode.js";
import type {
    CommitmentChunkOut,
    FmdHead,
    FmdMatchesPage,
    FmdNoteOut,
    FmdTreeState,
    NullifierChunkOut,
    SubscriptionOut,
} from "./wire.js";

/** Bytes in a packed Baby-Jubjub point: `y` plus one sign bit. */
const PACKED_POINT_BYTES = 32;

/** Shared by `/v1/notes` and `/v1/matches`, which differ only in the id field. */
export function note(raw: unknown, idField: "id" | "noteId", path: string): FmdNoteOut {
    const d = obj(raw, path);
    return {
        id: int(d[idField], `${path}.${idField}`),
        chainId: int(d.chainId, `${path}.chainId`),
        blockNumber: int(d.blockNumber, `${path}.blockNumber`),
        leafIndex: int(d.leafIndex, `${path}.leafIndex`),
        cm: hexInt(d.commitmentHex, `${path}.commitmentHex`),
        ciphertext: hexBytes(d.ciphertextHex, `${path}.ciphertextHex`),
        // Width-checked because `epk` reaches `decryptNote` untouched: a wrong
        // length would otherwise surface as a decryption failure with no link
        // back to the response.
        epk: hexBytesN(d.ephPubPackedHex, `${path}.ephPubPackedHex`, PACKED_POINT_BYTES),
    };
}

export function head(raw: unknown): FmdHead {
    const d = obj(raw, "$");
    return {
        chainId: int(d.chainId, "$.chainId"),
        maxNoteId: int(d.maxNoteId, "$.maxNoteId"),
        maxNullifierSeq: int(d.maxNullifierSeq, "$.maxNullifierSeq"),
    };
}

export function treeState(raw: unknown): FmdTreeState {
    const d = obj(raw, "$");
    return {
        chainId: int(d.chainId, "$.chainId"),
        leafCount: int(d.leafCount, "$.leafCount"),
        root: hexInt(d.rootHex, "$.rootHex"),
        frontier: mapArr(d.frontierHex, "$.frontierHex", (lvl, p) => mapArr(lvl, p, hexInt)),
    };
}

export function commitmentChunk(raw: unknown): CommitmentChunkOut {
    const d = obj(raw, "$");
    return {
        chunkId: int(d.chunkId, "$.chunkId"),
        entries: mapArr(d.entries, "$.entries", (e, p) => {
            const entry = obj(e, p);
            return {
                leafIndex: int(entry.leafIndex, `${p}.leafIndex`),
                leafHash: hexInt(entry.leafHash, `${p}.leafHash`),
            };
        }),
        isComplete: bool(d.isComplete, "$.isComplete"),
    };
}

export function nullifierChunk(raw: unknown): NullifierChunkOut {
    const d = obj(raw, "$");
    return {
        chunkId: int(d.chunkId, "$.chunkId"),
        nullifiers: mapArr(d.nullifiers, "$.nullifiers", hexInt),
        isComplete: bool(d.isComplete, "$.isComplete"),
    };
}

export function subscription(raw: unknown): SubscriptionOut {
    const d = obj(raw, "$");
    return {
        gamma: int(d.gamma, "$.gamma"),
        active: bool(d.active, "$.active"),
        created: bool(d.created, "$.created"),
    };
}

/** `/v1/notes` — a bare array of note rows. */
export function notesPage(raw: unknown): FmdNoteOut[] {
    return mapArr(raw, "$", (row, p) => note(row, "id", p));
}

/** `/v1/matches` — rows plus the backfill watermark. */
export function matchesPage(raw: unknown): FmdMatchesPage {
    const d = obj(raw, "$");
    return {
        matches: mapArr(d.matches, "$.matches", (row, p) => note(row, "noteId", p)),
        backfilledThroughNoteId: int(d.backfilledThroughNoteId, "$.backfilledThroughNoteId"),
    };
}
