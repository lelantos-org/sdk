// Per-output OutputAux builder. Joins ECDH `epk`, FMD clue `(R, c_bits)`,
// and ChaCha20-Poly1305 ciphertext (prefixed with 2B big-endian clueBits).
// Both real and pad slots go through `buildOutputAux`.

import { bitAt } from "../core/bits.js";
import type { Jubjub, Point } from "../crypto/jubjub.js";
import type { Field, Poseidon } from "../crypto/poseidon.js";
import { type FmdFlagKey, fmdFlag } from "../fmd/fmd.js";
import {
    clueBitsToPrefix,
    encodeNotePayload,
    type NotePayload,
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
 * Twisted-Edwards identity. Use as a placeholder for fields where on-curve
 * is required but the value is unused (e.g. pad-output `aux.ephPub` when
 * no plaintext exists). Note: SNARK-bound `clueR` cannot use this — the
 * circuit forces `R = r·G_8` for any witnessed `r ≠ 0`.
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

    // Re-pack clueBits as a single field element, LSB-first within γ bits.
    let clueBitsField: bigint = 0n;
    for (let i = 0; i < clue.gamma; i++) {
        if (bitAt(clue.bits, i)) clueBitsField |= 1n << BigInt(i);
    }

    return {
        aux: { clueR: clueRPoint, ephPub, ciphertext },
        witness: {
            clueBits: clueBitsField,
            clueRx: clueRPoint[0],
            clueRy: clueRPoint[1],
        },
    };
}
