// Trial-decrypt scanning.
//
// Lazy-root model: the chain holds only `roots[ring]` + `isKnownRoot` +
// `committedCount`. Leaves and merkle paths live with the relayer; wallets
// verify by recomputing the root and asserting `isKnownRoot` (see
// `crypto/path.ts`).

import type { Field, Jubjub } from "../crypto/index.js";
import { getLogger } from "../log/logger.js";
import { decodeNotePayload, type NotePayload, stripClueBitsPrefix } from "../notes/codec.js";
import { decryptNote } from "../notes/encrypt.js";

const log = getLogger("lelantos:sync:scan");

export interface ScanInput {
    /** Wire ciphertext: 2B clueBits prefix + ChaCha body, unstripped. */
    ciphertext: Uint8Array;
    /** Packed Baby-Jubjub recipient ECDH ephemeral pubkey. */
    epk: Uint8Array;
    cm: Field;
    leafIndex: number;
}

export interface ScanHit extends NotePayload {
    cm: Field;
    leafIndex: number;
}

/**
 * Per-scan tallies. They are what distinguishes a systematic decode failure
 * from an empty result; the log line alone cannot.
 */
export interface ScanStats {
    scanned: number;
    /** ECDH/ChaCha tag mismatch — expected for notes that are not ours. */
    notOurs: number;
    /** Tag verified but the plaintext was not a NotePayload. Should be 0. */
    decodeFailed: number;
    /** Self-pad outputs: decrypt cleanly, value 0, unspendable. */
    zeroValue: number;
    hits: number;
}

export function emptyScanStats(): ScanStats {
    return { scanned: 0, notOurs: 0, decodeFailed: 0, zeroValue: 0, hits: 0 };
}

/**
 * Trial-decrypt with `ivk`; return notes whose ChaCha tag verifies and whose
 * plaintext decodes.
 *
 * Pass `stats` to collect tallies; it is mutated in place so the hot loop
 * allocates nothing.
 */
export function scanNotes(
    J: Jubjub,
    ivk: Field,
    inputs: ScanInput[],
    stats?: ScanStats,
): ScanHit[] {
    const hits: ScanHit[] = [];
    for (const inp of inputs) {
        if (stats) stats.scanned++;
        const { body } = stripClueBitsPrefix(inp.ciphertext);
        const plain = decryptNote({ J, ivk, note: { epk: inp.epk, ciphertext: body } });
        if (!plain) {
            if (stats) stats.notOurs++;
            continue;
        }
        try {
            const payload = decodeNotePayload(plain);
            // Self-pad outputs decrypt cleanly but are unspendable; they
            // would otherwise pile up as phantom unspent notes.
            if (payload.value === 0n) {
                if (stats) stats.zeroValue++;
                continue;
            }
            hits.push({ ...payload, cm: inp.cm, leafIndex: inp.leafIndex });
            if (stats) stats.hits++;
        } catch (err) {
            // One corrupt note must not abort a scan, but a decode failure
            // after a verified ChaCha tag means the payload encoding has
            // drifted — a protocol bug worth surfacing.
            if (stats) stats.decodeFailed++;
            if (log.enabled("debug")) {
                log.debug("note decrypted but failed to decode", {
                    leafIndex: inp.leafIndex,
                    bytes: plain.length,
                    err,
                });
            }
        }
    }
    return hits;
}
