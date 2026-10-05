// Trial-decrypt scanning.
//
// A note is a hit only when everything the sender published for it is the function of the opened
// plaintext that an honest sender computes: the commitment, the ECDH ephemeral `epk = esk · g_d`
// and the FMD clue, with `rcm`, `esk` and the clue blinder expanded from the plaintext's `rseed`
// and `g_d` the base of the address its `d` names.
//
// Runs inside the scanner worker and the watch-only bundle: leaf imports only, and nothing from
// `keys/diversifier.ts`, which would pull in AES.

import { bytesEqual } from "../core/bytes.js";
import { buildNoteCommitment } from "../crypto/commit.js";
import { diversifiedBase } from "../crypto/diversified-base.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import { PACKED_POINT_BYTES } from "../crypto/jubjub-wasm/point-codec.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { fmdDiversifiedDetectionKey, fmdExpectedClueOnBase } from "../fmd/diversified.js";
import { FMD_DEFAULT_GAMMA, type FmdDetectionKey } from "../fmd/keys.js";
import { deriveDiversifiedPk, deriveDkRoot } from "../keys/diversified.js";
import { getLogger } from "../log/logger.js";
import { clueBitsToPrefix, decodeNotePayload, stripClueBitsPrefix } from "../notes/codec.js";
import { decryptNote } from "../notes/encrypt.js";
import { expandSeed } from "../notes/seed.js";

const log = getLogger("lelantos:sync:scan");

export interface ScanInput {
    /** Wire ciphertext: 2B clueBits prefix + ChaCha body, unstripped. */
    ciphertext: Uint8Array;
    /** Packed Baby-Jubjub recipient ECDH ephemeral pubkey. */
    epk: Uint8Array;
    /** Packed Baby-Jubjub clue point `R`, as published with the note. */
    clueR: Uint8Array;
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

export interface ScanHit {
    asset: Field;
    value: Field;
    rho: Field;
    /** Commitment blinder, expanded from the plaintext's `rseed`. */
    rcm: Field;
    /** Diversifier of the address the note was sent to: `pk = Poseidon(TAG_PK, ivk, d)`. */
    d: Field;
    cm: Field;
    leafIndex: number;
    blockNumber: number;
}

/** Per-scan tallies, which distinguish a systematic decode failure from an empty result. */
export interface ScanStats {
    scanned: number;
    /** ECDH/ChaCha tag mismatch; expected for notes addressed to other keys. */
    notOurs: number;
    /**
     * The input's `epk` or `clueR` is not 32 bytes; or the tag verified and checking the plaintext
     * threw: it is not a NotePayload, its `rho` is not a canonical field element, or a later check
     * threw. Should be 0.
     */
    decodeFailed: number;
    /**
     * Value-0 notes that decrypt under this key: unspendable, and dropped before the commitment,
     * ephemeral-key and clue checks.
     * The wallet seals none to a held address: a spend's pads and the fee leaf of a deposit that
     * charged no fee go to one-time recipients no one holds, and count as `notOurs`. A non-zero
     * tally means a sender addressed a value-0 output to this account through the bundle builders
     * or another client.
     */
    zeroValue: number;
    /**
     * Decrypted cleanly but the payload does not open the feed's `cm`. Should be 0: otherwise the
     * feed serves commitments that do not match their ciphertexts, or a sender built an
     * unspendable output or deposit. See the check in {@link scanNotes}.
     */
    cmMismatch: number;
    /**
     * Opens `cm`, but `epk` is not `esk · g_d` for the `esk` the plaintext's seed expands to and
     * the address its `d` names. Should be 0 for honest senders.
     */
    ephemeralMismatch: number;
    /**
     * Opens `cm` under the right `epk`, but the published clue (`R` or the bits prefix) is not the
     * clue the plaintext's seed yields for the address its `d` names. Should be 0 for honest
     * senders.
     */
    clueMismatch: number;
    hits: number;
}

export function emptyScanStats(): ScanStats {
    return {
        scanned: 0,
        notOurs: 0,
        decodeFailed: 0,
        zeroValue: 0,
        cmMismatch: 0,
        ephemeralMismatch: 0,
        clueMismatch: 0,
        hits: 0,
    };
}

/** What `ivk` holds for one diversifier, kept for the length of a scan. */
interface AddressKeys {
    pk: Field;
    gD: Point;
}

/** The tallies of a note that opened and then failed one check against what was published. */
type Mismatch = "cmMismatch" | "ephemeralMismatch" | "clueMismatch";

/**
 * Trial-decrypt `inputs` with `ivk`; return the non-zero-value notes whose ChaCha tag verifies,
 * whose plaintext decodes, and whose commitment, ephemeral key and clue are the ones the
 * plaintext determines.
 *
 * `stats`, when passed, is mutated in place.
 *
 * @throws {InvalidArgumentError} when `ivk` is not canonical or its FMD root secret is zero mod q.
 * @throws {WireFormatError} when a ciphertext is shorter than its clue-bits prefix.
 */
export function scanNotes(
    J: Jubjub,
    P: Poseidon,
    ivk: Field,
    inputs: ScanInput[],
    stats?: ScanStats,
): ScanHit[] {
    const tally = stats ?? emptyScanStats();
    const dkRoot = deriveDkRoot(P, ivk);
    // One detection key serves every address of `ivk`. Built for the first note that reaches the
    // clue check, so a scan of foreign notes alone does not pay for it.
    let detectionKey: FmdDetectionKey | undefined;
    // `pk` and `g_d` are not transmitted; both are functions of `ivk` and the plaintext's `d`.
    const addresses = new Map<Field, AddressKeys>();
    const addressOf = (d: Field): AddressKeys => {
        let keys = addresses.get(d);
        if (keys === undefined) {
            keys = { pk: deriveDiversifiedPk(P, ivk, d), gD: diversifiedBase(J, P, d) };
            addresses.set(d, keys);
        }
        return keys;
    };
    const mismatch = (kind: Mismatch, leafIndex: number, message: string): void => {
        tally[kind]++;
        if (log.enabled("debug")) log.debug(message, { leafIndex });
    };

    /** Check a decrypted note against what was published; a rejected one is tallied here. */
    const check = (inp: ScanInput, prefix: Uint8Array, plain: Uint8Array): ScanHit | undefined => {
        const { asset, value, rho, rseed, d } = decodeNotePayload(plain);
        // Value-0 notes are unspendable and would otherwise pile up as phantom unspent notes.
        if (value === 0n) {
            tally.zeroValue++;
            return undefined;
        }
        const { rcm, esk, fmdR } = expandSeed(rseed, rho);
        const { pk, gD } = addressOf(d);

        // The plaintext opens the feed's `cm`, which commits to `(asset, value)` and, through
        // `inner`, to `(pk, rho, rcm)`. A deposit's leaf is built from the escrow's public
        // `(asset, value)` and published `inner`, so this also checks that the plaintext states
        // the escrowed amount. Without it, a note committed under another `pk`, or a deposit
        // whose ciphertext overstates its value, would be stored, counted in the balance and
        // selected, then fail at spend time.
        //
        // Asset id 0 means "no asset": the circuits put no value under it, so a valued plaintext
        // naming it opens no leaf.
        if (asset === 0n || buildNoteCommitment(P, { asset, value, pk, rho, rcm }) !== inp.cm) {
            mismatch(
                "cmMismatch",
                inp.leafIndex,
                "note decrypted but its commitment does not match the feed",
            );
            return undefined;
        }

        // `ivk · epk` opens a note sent on the base of any address of this account, whatever `d`
        // its plaintext names. Accepting one whose `epk` is on another base would tell its sender
        // that the two addresses share an owner.
        if (!bytesEqual(J.packPoint(J.mulPointEscalar(gD, esk)), inp.epk)) {
            mismatch(
                "ephemeralMismatch",
                inp.leafIndex,
                "note opens its commitment but its ephemeral key is not the seed's",
            );
            return undefined;
        }

        // A hit requires the exact clue an honest sender publishes for address `d`. The result
        // then does not depend on whether the feed was FMD-filtered, and a clue made for another
        // address of this account is refused like one made for a stranger.
        detectionKey ??= fmdDiversifiedDetectionKey(P, dkRoot, FMD_DEFAULT_GAMMA);
        const clue = fmdExpectedClueOnBase(J, P, detectionKey, gD, fmdR);
        if (
            !bytesEqual(clue.R, inp.clueR) ||
            !bytesEqual(clueBitsToPrefix(clue.bits, clue.gamma), prefix)
        ) {
            mismatch(
                "clueMismatch",
                inp.leafIndex,
                "note opens its commitment but its clue is not the seed's",
            );
            return undefined;
        }

        return {
            asset,
            value,
            rho,
            rcm,
            d,
            cm: inp.cm,
            leafIndex: inp.leafIndex,
            blockNumber: inp.blockNumber,
        };
    };

    const hits: ScanHit[] = [];
    for (const inp of inputs) {
        tally.scanned++;
        const { prefix, body } = stripClueBitsPrefix(inp.ciphertext);
        // A note source is pluggable, and decryption throws on an `epk` of another length: one
        // malformed row must not abort the scan of the rows around it.
        if (inp.epk.length !== PACKED_POINT_BYTES || inp.clueR.length !== PACKED_POINT_BYTES) {
            tally.decodeFailed++;
            if (log.enabled("debug")) {
                log.debug("note input has an ephemeral key or clue point of the wrong length", {
                    leafIndex: inp.leafIndex,
                    epkBytes: inp.epk.length,
                    clueRBytes: inp.clueR.length,
                });
            }
            continue;
        }
        const plain = decryptNote({ J, ivk, note: { epk: inp.epk, ciphertext: body } });
        if (!plain) {
            tally.notOurs++;
            continue;
        }

        // A plaintext that decrypts is its sender's and stays in the feed for good. Any throw
        // while checking it is counted and the scan moves on: it costs that note, not the sync.
        try {
            const hit = check(inp, prefix, plain);
            if (hit) {
                hits.push(hit);
                tally.hits++;
            }
        } catch (err) {
            tally.decodeFailed++;
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
