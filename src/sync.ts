// Lazy-root model: chain holds only `roots[ring]` + `isKnownRoot` +
// `committedCount`. Leaves and merkle paths live with the relayer; wallets
// verify by recomputing the root and asserting `isKnownRoot`.

// `TAG_MERKLE` imported from the leaf module — the barrel `./crypto/index.js`
// pulls `circomlibjs` (CJS `blake2b`) which Vite's worker pre-bundle can't
// shim, so any worker importing this file would crash on module load.
import type { Field, Jubjub, Poseidon } from "./crypto/index.js";
import { TAG_MERKLE } from "./crypto/tags.js";
import { type FmdClue, type FmdDetectionKey, fmdTest } from "./fmd.js";
import { decodeNotePayload, type NotePayload, stripClueBitsPrefix } from "./note-codec.js";
import { decryptNote } from "./note-encrypt.js";

const ARITY = 4;

export interface ScanInput {
    /// Wire ciphertext: 2B clueBits prefix + ChaCha body, unstripped.
    ciphertext: Uint8Array;
    /// Packed Baby-Jubjub recipient ECDH ephemeral pubkey.
    epk: Uint8Array;
    cm: Field;
    leafIndex: number;
    /// Cheap FMD pre-reject. Only consulted when `scanNotes` gets a detection key.
    clue?: FmdClue;
}

export interface ScanHit extends NotePayload {
    cm: Field;
    leafIndex: number;
}

/// Trial-decrypt with `ivk`; return notes whose ChaCha tag verifies and
/// plaintext decodes. `detectionKey` is an optional FMD pre-filter.
export function scanNotes(
    J: Jubjub,
    P: Poseidon,
    ivk: Field,
    inputs: ScanInput[],
    detectionKey?: FmdDetectionKey,
): ScanHit[] {
    const hits: ScanHit[] = [];
    for (const inp of inputs) {
        if (detectionKey && inp.clue) {
            if (!fmdTest(J, P, detectionKey, inp.clue)) continue;
        }
        const { body } = stripClueBitsPrefix(inp.ciphertext);
        const plain = decryptNote({ J, ivk, note: { epk: inp.epk, ciphertext: body } });
        if (!plain) continue;
        try {
            const payload = decodeNotePayload(plain);
            // Self-pad outputs decrypt cleanly but are unspendable; would
            // otherwise pile up as phantom unspent notes.
            if (payload.value === 0n) continue;
            hits.push({ ...payload, cm: inp.cm, leafIndex: inp.leafIndex });
        } catch {
            /* body decoded as something other than NotePayload — skip. */
        }
    }
    return hits;
}

export function rootFromPath(
    P: Poseidon,
    leaf: Field,
    pathElements: Field[][],
    pathIndices: number[],
): Field {
    let cur: Field = leaf;
    for (let lvl = 0; lvl < pathIndices.length; lvl++) {
        const slot = pathIndices[lvl];
        const sibs = pathElements[lvl];
        const children: Field[] = [];
        let s = 0;
        for (let k = 0; k < ARITY; k++) {
            if (k === slot) children.push(cur);
            else children.push(sibs[s++]);
        }
        cur = P.hash([TAG_MERKLE, children[0], children[1], children[2], children[3]]);
    }
    return cur;
}

export async function verifyPath(
    P: Poseidon,
    leaf: Field,
    pathElements: Field[][],
    pathIndices: number[],
    isKnownRootOnChain: (root: Field) => Promise<boolean>,
): Promise<boolean> {
    const root = rootFromPath(P, leaf, pathElements, pathIndices);
    return isKnownRootOnChain(root);
}
