// Trial-decrypt scanning.
//
// Lazy-root model: the chain holds only `roots[ring]` + `isKnownRoot` +
// `committedCount`. Leaves and merkle paths live with the relayer; wallets
// verify by recomputing the root and asserting `isKnownRoot` (see
// `crypto/path.ts`).

import type { Field, Jubjub, Poseidon } from "../crypto/index.js";
import { buildNoteCommitment, derivePkFromIvk } from "../crypto/index.js";
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
    /** Block the note landed in. Stored as `StoredNote.firstSeenBlock`. */
    blockNumber: number;
}

export interface ScanHit extends NotePayload {
    cm: Field;
    leafIndex: number;
    blockNumber: number;
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
    /**
     * Decrypted cleanly but the payload does not reproduce the feed's `cm`.
     * Should be 0: a non-zero count means the feed is serving commitments that
     * do not match their ciphertexts, or a sender built an output we cannot
     * spend. See the check in {@link scanNotes}.
     */
    cmMismatch: number;
    hits: number;
}

export function emptyScanStats(): ScanStats {
    return { scanned: 0, notOurs: 0, decodeFailed: 0, zeroValue: 0, cmMismatch: 0, hits: 0 };
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
    P: Poseidon,
    ivk: Field,
    inputs: ScanInput[],
    stats?: ScanStats,
): ScanHit[] {
    // `pk` is not transmitted — the recipient reconstructs it from their own
    // `ivk` — so it is derived once here and used to reproduce each hit's
    // commitment below.
    const pk = derivePkFromIvk(P, ivk);
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
            // The feed supplies `cm`; nothing else on this path checks that it
            // is the commitment this plaintext actually opens. Without the
            // check a note that decrypts but was committed under a different
            // `pk` is stored, counted in the balance, and offered to the
            // selector — then fails at spend time, after a full Groth16
            // prove, because `toSpentNoteFromPath` recomputes `cm` from
            // `(asset, value, ownPk, rho, rcm)` and gets a value that is not
            // the leaf at `leafIndex`. One Poseidon-4 per hit — and hits are
            // rare — buys a local rejection with a counter instead.
            if (buildNoteCommitment(P, { ...payload, pk }) !== inp.cm) {
                if (stats) stats.cmMismatch++;
                if (log.enabled("debug")) {
                    log.debug("note decrypted but its commitment does not match the feed", {
                        leafIndex: inp.leafIndex,
                    });
                }
                continue;
            }

            hits.push({
                ...payload,
                cm: inp.cm,
                leafIndex: inp.leafIndex,
                blockNumber: inp.blockNumber,
            });
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
