// Wallet-side tree sync helpers.
//
// In the lazy-root model the chain holds only `roots[ring]` + `isKnownRoot`
// + `committedCount`. The actual leaves and merkle paths live with the
// relayer. Wallets verify any path the relayer hands them by recomputing
// the root from `(leaf, pathElements, pathIndices)` and asserting the
// result is on-chain `isKnownRoot`. Soundness gives no path-forgery vector.

import { type Field, type Jubjub, type Poseidon, TAG_MERKLE } from "./crypto/index.js";
import { type FmdClue, type FmdDetectionKey, fmdTest } from "./fmd.js";
import { decodeNotePayload, type NotePayload, stripClueBitsPrefix } from "./note-codec.js";
import { decryptNote } from "./note-encrypt.js";

const ARITY = 4;

export interface ScanInput {
    /// Wire ciphertext (2B clueBits prefix + ChaCha body), unstripped.
    ciphertext: Uint8Array;
    /// Recipient ECDH ephemeral pub (packed Baby-Jubjub).
    epk: Uint8Array;
    /// On-chain commitment for this note (used by callers to look up paths).
    cm: Field;
    leafIndex: number;
    /// Optional FMD clue. If provided AND a detection key is supplied to
    /// `scanNotes`, the clue is tested first as a cheap reject.
    clue?: FmdClue;
}

export interface ScanHit extends NotePayload {
    cm: Field;
    leafIndex: number;
}

/// Trial-decrypt every note with the given ivk; return the ones whose
/// ChaCha tag verifies and whose plaintext decodes cleanly.
///
/// `detectionKey` is optional: when supplied, FMD is used as a pre-filter
/// to skip clearly-not-mine notes without paying the ECDH+ChaCha cost.
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
            // Drop self-pad outputs (value=0n) emitted by deposits for FMD
            // privacy. They decrypt cleanly but are not spendable and would
            // otherwise pile up as phantom unspent notes.
            if (payload.value === 0n) continue;
            hits.push({ ...payload, cm: inp.cm, leafIndex: inp.leafIndex });
        } catch {
            /* tag passed but body did not decode as a NotePayload — skip. */
        }
    }
    return hits;
}

/// Recompute the merkle root from a path supplied by the relayer.
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

/// Verify a relayer-supplied merkle path against an on-chain root oracle.
/// Caller passes a `isKnownRootOnChain(root)` predicate (e.g. an
/// ethers-contract `isKnownRoot(bytes32)` view call).
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
