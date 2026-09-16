// Per-output OutputAux builder. Joins ECDH `epk`, FMD clue `(R, c_bits)`,
// and ChaCha20-Poly1305 ciphertext (prefixed with 2B big-endian clueBits).
// Both real and pad slots go through `buildOutputAux`.

import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { assertInvariant } from "../errors/base.js";
import { fmdFlag } from "../fmd/clue.js";
import type { FmdFlagKey } from "../fmd/keys.js";
import {
    clueBitsToPrefix,
    encodeNotePayload,
    type NotePayload,
    packClueBits,
    withClueBitsPrefix,
} from "./codec.js";
import { encryptNote } from "./encrypt.js";

/** @internal */
export interface OutputAux {
    clueR: Point;
    ephPub: Point;
    /** Wire bytes: 2B clueBits prefix || ChaCha20-Poly1305(body). */
    ciphertext: Uint8Array;
}

/** @internal */
export interface OutputAuxWithWitness {
    aux: OutputAux;
    /**
     * Plain public inputs for the clue: client-computed off-circuit,
     * PolyEval-bound to the proof. Relayer cannot alter without invalidating.
     */
    witness: {
        clueBits: Field;
        clueRx: Field;
        clueRy: Field;
    };
}

/**
 * Twisted-Edwards identity. Placeholder for fields that must be on-curve but
 * are unused (e.g. pad-output `aux.ephPub` when no plaintext exists). Not valid
 * for SNARK-bound `clueR`: the circuit forces `R = r·G_8` for any witnessed `r ≠ 0`.
 *
 * @internal
 */
export const ON_CURVE_IDENTITY: Point = [0n, 1n];

/** @internal */
export interface BuildAuxArgs {
    J: Jubjub;
    P: Poseidon;
    recipientFlagKey: FmdFlagKey;
    recipientPkD: Point;
    note: NotePayload;
    /** ECDH ephemeral secret, fresh per output. MUST be uniform in Z_q*. */
    esk: Field;
    /** FMD blinding scalar, fresh per output. MUST be uniform in Z_q*. */
    fmdR: Field;
}

/** @internal */
export function buildOutputAux(args: BuildAuxArgs): OutputAuxWithWitness {
    const { J, P, recipientFlagKey, recipientPkD, note, esk, fmdR } = args;

    const clue = fmdFlag(J, P, recipientFlagKey, fmdR);
    const clueRPoint = J.unpackPoint(clue.R);
    assertInvariant(clueRPoint, "aux: clue.R failed to unpack");

    const enc = encryptNote({
        J,
        recipientPkD,
        esk,
        plaintext: encodeNotePayload(note),
    });

    const ephPub = J.unpackPoint(enc.epk);
    assertInvariant(ephPub, "aux: epk failed to unpack");

    const prefix = clueBitsToPrefix(clue.bits, clue.gamma);
    const ciphertext = withClueBitsPrefix(prefix, enc.ciphertext);

    // Same packing the wire prefix above is derived from. The contract
    // recomputes this slot from that prefix, so a mismatch fails verification.
    const clueBitsField = packClueBits(clue.bits, clue.gamma);

    return {
        aux: { clueR: clueRPoint, ephPub, ciphertext },
        witness: {
            clueBits: clueBitsField,
            clueRx: clueRPoint[0],
            clueRy: clueRPoint[1],
        },
    };
}
