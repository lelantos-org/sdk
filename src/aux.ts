// Per-output OutputAux builder.
//
// Joins the three things the relayer + indexers need off-circuit for each
// real output slot:
//   - ECDH ephemeral pub `epk` (so the receiver can recompute the KDF)
//   - FMD clue `(R, c_bits)` so the indexer can fan-out to subscribers
//   - ChaCha20-Poly1305 ciphertext of the 80B note plaintext, prefixed
//     with the 2B big-endian clueBits the rust filter expects
//
// Pad slots use `EMPTY_AUX`. Real outputs go through `buildOutputAux`.

import { type Jubjub, BABYJUB_SUBGROUP_ORDER, type Field, type Point } from "./crypto/index";
import {
    fmdFlag,
    fmdFlagKeyFromDetection,
    fmdGenDetectionKey,
    type FmdDetectionKey,
    type FmdFlagKey,
    FMD_DEFAULT_GAMMA,
} from "./fmd";
import { encryptNote } from "./note-encrypt";
import {
    encodeNotePayload,
    clueBitsToPrefix,
    withClueBitsPrefix,
    type NotePayload,
} from "./note-codec";

export interface OutputAux {
    clueR: Point;
    ephPub: Point;
    /// Wire bytes: 2B clueBits prefix || ChaCha20-Poly1305(body).
    ciphertext: Uint8Array;
}

export const EMPTY_AUX: OutputAux = {
    clueR: [0n, 0n],
    ephPub: [0n, 0n],
    ciphertext: new Uint8Array([0, 0]),
};

export interface BuildAuxArgs {
    J: Jubjub;
    /// Recipient flag-key (group elements). Caller derives via:
    ///   fmdFlagKeyFromDetection(J, fmdGenDetectionKey(seedFn, gamma)).
    /// For convenience pass the Detection-key seed scalar in `dkSeed` and
    /// let `buildOutputAux` derive both — see `buildOutputAuxFromAddress`.
    recipientFlagKey: FmdFlagKey;
    recipientPkD: Point;
    note: NotePayload;
    /// ECDH ephemeral secret, fresh per output. MUST be uniform in Z_q*.
    esk: Field;
    /// FMD blinding scalar, fresh per output. MUST be uniform in Z_q*.
    fmdR: Field;
}

export function buildOutputAux(args: BuildAuxArgs): OutputAux {
    const { J, recipientFlagKey, recipientPkD, note, esk, fmdR } = args;

    const clue = fmdFlag(J, recipientFlagKey, fmdR);
    const clueRPoint = J.unpackPoint(clue.R);
    if (!clueRPoint) throw new Error("aux: clue.R failed to unpack");

    const enc = encryptNote({
        J,
        recipientPkD,
        esk,
        plaintext: encodeNotePayload(note),
    });

    const ephPub = J.unpackPoint(enc.epk);
    if (!ephPub) throw new Error("aux: epk failed to unpack");

    const prefix = clueBitsToPrefix(clue.bits, clue.gamma);
    const ciphertext = withClueBitsPrefix(prefix, enc.ciphertext);

    return { clueR: clueRPoint, ephPub, ciphertext };
}

/// Convenience: derive a deterministic flag-key from a single scalar `dkSeed`
/// (the `dk` field in a bech32m address). Each γ-component scalar is mixed
/// from `dkSeed` via a counter, matching the receiver's wallet that
/// generates its detection key from the same seed.
export function flagKeyFromAddressDk(
    J: Jubjub,
    dkSeed: Field,
    gamma: number = FMD_DEFAULT_GAMMA,
): { detection: FmdDetectionKey; flag: FmdFlagKey } {
    let n = dkSeed;
    const stream = (): Field => {
        n = (n + 0x9e3779b97f4a7c15n) % BABYJUB_SUBGROUP_ORDER;
        return n === 0n ? 1n : n;
    };
    const detection = fmdGenDetectionKey(stream, gamma);
    const flag = fmdFlagKeyFromDetection(J, detection);
    return { detection, flag };
}
