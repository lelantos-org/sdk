// Trial-decrypt scanning.

import type { Field, Jubjub, Poseidon } from "../crypto/index.js";
import { buildNoteCommitment } from "../crypto/index.js";
import { deriveDefaultPk } from "../keys/diversified.js";
import { getLogger } from "../log/logger.js";
import { decodeNotePayload, type NotePayload, stripClueBitsPrefix } from "../notes/codec.js";
import { decryptNote } from "../notes/encrypt.js";

const log = getLogger("lelantos:sync:scan");

export interface ScanInput {
    /** Wire ciphertext: 2B clueBits prefix + ChaCha body, unstripped. */
    ciphertext: Uint8Array;
    /** Packed Baby-Jubjub recipient ECDH ephemeral pubkey. */
    epk: Uint8Array;
    /**
     * The tree leaf at `leafIndex`, i.e. the note commitment: a spend output's published `outCm`,
     * or for a deposit `commitWithInner(publicAssetId, publicIn, inner)` over the escrow's public
     * fields (the fee note: `feeAssetId`, `feeIn`, `feeInner`), as the batch circuit builds it.
     */
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

/** Per-scan tallies, which distinguish a systematic decode failure from an empty result. */
export interface ScanStats {
    scanned: number;
    /** ECDH/ChaCha tag mismatch; expected for notes addressed to other keys. */
    notOurs: number;
    /** Tag verified but the plaintext was not a NotePayload. Should be 0. */
    decodeFailed: number;
    /**
     * Value-0 notes (self-pad outputs, the fee note of a deposit that charged no fee): decrypt
     * cleanly, unspendable.
     */
    zeroValue: number;
    /**
     * Decrypted cleanly but the payload does not open the feed's `cm`. Should be 0: otherwise the
     * feed serves commitments that do not match their ciphertexts, or a sender built an
     * unspendable output or deposit. See the check in {@link scanNotes}.
     */
    cmMismatch: number;
    hits: number;
}

export function emptyScanStats(): ScanStats {
    return { scanned: 0, notOurs: 0, decodeFailed: 0, zeroValue: 0, cmMismatch: 0, hits: 0 };
}

/**
 * Trial-decrypt `inputs` with `ivk`; return the non-zero-value notes whose ChaCha tag verifies,
 * whose plaintext decodes and whose commitment matches the feed's `cm`.
 *
 * `stats`, when passed, is mutated in place.
 */
export function scanNotes(
    J: Jubjub,
    P: Poseidon,
    ivk: Field,
    inputs: ScanInput[],
    stats?: ScanStats,
): ScanHit[] {
    // `pk` is not transmitted; it is derived once from `ivk`, under the account's default
    // diversifier, to reproduce each hit's commitment.
    const pk = deriveDefaultPk(P, ivk);
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
            // Value-0 notes are unspendable and would otherwise pile up as phantom unspent notes.
            if (payload.value === 0n) {
                if (stats) stats.zeroValue++;
                continue;
            }
            // The only check that the plaintext opens the feed's `cm`, which commits to
            // `(asset, value)` and, through `inner`, to `(pk, rho, rcm)`. A deposit's leaf is
            // built from the escrow's public `(asset, value)` and published `inner`, so this also
            // checks that the plaintext states the escrowed amount. Without it, a note committed
            // under another `pk`, or a deposit whose ciphertext overstates its value, would be
            // stored, counted in the balance and selected, then fail at spend time.
            //
            // Asset id 0 means "no asset": the circuits put no value under it, so a valued
            // plaintext naming it opens no leaf.
            if (payload.asset === 0n || buildNoteCommitment(P, { ...payload, pk }) !== inp.cm) {
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
            // One corrupt note must not abort a scan. A decode failure after a verified ChaCha tag
            // indicates a payload encoding mismatch, so it is counted and logged.
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
